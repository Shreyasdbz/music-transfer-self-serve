// Apple Music read client (Phase 3 surface).
//
// Every authenticated call carries BOTH headers per blueprint §5.2:
//   Authorization: Bearer <long-lived dev token>
//   Music-User-Token: <MUT>
//
// Storefront is resolved dynamically from `/v1/me/storefront` (never hardcoded
// — see §5.2). The result is cached for the lifetime of the process so we don't
// hit the endpoint on every catalog search; preflight re-resolves on each run.

import { getLongLivedDevToken, getMut } from "../auth/apple.js";
import { httpJson } from "../util/http.js";

const API = "https://api.music.apple.com";
const MAX_PAGES = 200;

function authedHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getLongLivedDevToken()}`,
    "Music-User-Token": getMut(),
    Accept: "application/json",
  };
}

function devTokenHeaders(): Record<string, string> {
  // Catalog reads only need the dev token, not the MUT. We still send the MUT
  // when available so storefront and rate-limit accounting bind to the user.
  return {
    Authorization: `Bearer ${getLongLivedDevToken()}`,
    Accept: "application/json",
  };
}

// ── Storefront ────────────────────────────────────────────────────────────

interface StorefrontResponse {
  data: { id: string; attributes?: { defaultLanguageTag?: string; supportedLanguageTags?: string[] } }[];
}

let storefrontCache: string | undefined;

/** Returns the user's storefront id (e.g. "us"). Cached per process. */
export async function getStorefront(): Promise<string> {
  if (storefrontCache) return storefrontCache;
  const r = await httpJson<StorefrontResponse>({
    method: "GET",
    url: `${API}/v1/me/storefront`,
    headers: authedHeaders(),
  });
  const id = r.data[0]?.id;
  if (!id) throw new Error("apple_storefront_unresolved");
  storefrontCache = id;
  return id;
}

export function clearStorefrontCache(): void {
  storefrontCache = undefined;
}

// ── Library playlists ─────────────────────────────────────────────────────

export interface AppleLibraryPlaylist {
  readonly id: string;
  readonly attributes: {
    readonly name: string;
    readonly canEdit?: boolean;
    readonly description?: { standard?: string };
    readonly playParams?: { id: string; isLibrary?: boolean; globalId?: string };
  };
}

interface LibraryPlaylistsResponse {
  data: AppleLibraryPlaylist[];
  next?: string;
}

async function paginate<T>(firstPath: string, headers: Record<string, string>): Promise<T[]> {
  let nextPath: string | null = firstPath;
  const out: T[] = [];
  let pages = 0;
  while (nextPath && pages < MAX_PAGES) {
    const url = nextPath.startsWith("http") ? nextPath : `${API}${nextPath}`;
    const page: { data: T[]; next?: string } = await httpJson<{ data: T[]; next?: string }>({
      method: "GET",
      url,
      headers,
    });
    out.push(...page.data);
    nextPath = page.next ?? null;
    pages++;
  }
  return out;
}

export async function listLibraryPlaylists(): Promise<AppleLibraryPlaylist[]> {
  return paginate<AppleLibraryPlaylist>("/v1/me/library/playlists?limit=100", authedHeaders());
}

// ── Library tracks (within a playlist) ────────────────────────────────────

export interface AppleLibrarySong {
  readonly id: string;
  readonly type: "library-songs" | "songs";
  readonly attributes: {
    readonly name: string;
    readonly artistName: string;
    readonly albumName?: string;
    readonly durationInMillis?: number;
    readonly isrc?: string;
    readonly playParams?: { id: string; isLibrary?: boolean; catalogId?: string };
    readonly contentRating?: string; // "explicit" | "clean"
  };
}

export async function listLibraryPlaylistTracks(playlistId: string): Promise<AppleLibrarySong[]> {
  return paginate<AppleLibrarySong>(
    `/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`,
    authedHeaders(),
  );
}

// ── Library songs (the "Library" collection — distinct from Favorites) ────

/** All songs the user has added to their library. The blueprint pairs the
 * Operation source `Liked/Favorites` to this collection on the Apple side;
 * if Apple's separate "favorited songs" endpoint is needed for the matching
 * model, it'll be added in Phase 7 when the Operation resolves the source.
 * See §6.3 — the favorite-a-song REST route has shifted and any read endpoint
 * must be verified against live Apple docs before wiring. */
export async function listLibrarySongs(): Promise<AppleLibrarySong[]> {
  return paginate<AppleLibrarySong>("/v1/me/library/songs?limit=100", authedHeaders());
}

// ── Catalog search + ISRC lookup ──────────────────────────────────────────

export interface AppleCatalogSong {
  readonly id: string;
  readonly type: "songs";
  readonly attributes: {
    readonly name: string;
    readonly artistName: string;
    readonly albumName: string;
    readonly durationInMillis: number;
    readonly isrc?: string;
    readonly contentRating?: string;
  };
}

interface CatalogSongsResponse {
  data: AppleCatalogSong[];
  next?: string;
}

/** ISRC lookup per §7 Tier 1. Returns *all* candidates so the matcher can
 * disambiguate (multiple results across single/album/deluxe; some may 404
 * on a follow-up fetch — caller validates). */
export async function searchByIsrc(isrcs: string[]): Promise<AppleCatalogSong[]> {
  if (isrcs.length === 0) return [];
  const storefront = await getStorefront();
  // Apple accepts up to 25 ISRCs per call (§7).
  const out: AppleCatalogSong[] = [];
  for (let i = 0; i < isrcs.length; i += 25) {
    const chunk = isrcs.slice(i, i + 25);
    const url = `${API}/v1/catalog/${encodeURIComponent(storefront)}/songs?filter[isrc]=${chunk.map(encodeURIComponent).join(",")}`;
    const r = await httpJson<CatalogSongsResponse>({
      method: "GET",
      url,
      headers: devTokenHeaders(),
    });
    out.push(...r.data);
  }
  return out;
}

interface SearchResponse {
  results?: {
    songs?: { data: AppleCatalogSong[] };
  };
}

/** Scored-search fallback per §7 Tier 2. Returns up to `limit` candidates;
 * the matcher scores and picks. */
export async function searchCatalog(query: string, limit = 25): Promise<AppleCatalogSong[]> {
  const storefront = await getStorefront();
  const url = `${API}/v1/catalog/${encodeURIComponent(storefront)}/search?term=${encodeURIComponent(query)}&types=songs&limit=${limit}`;
  const r = await httpJson<SearchResponse>({
    method: "GET",
    url,
    headers: devTokenHeaders(),
  });
  return r.results?.songs?.data ?? [];
}

// ── Charts (for preflight's ISRC-fixture sourcing per §11.1) ──────────────

interface ChartContainer {
  chart?: string;
  data?: AppleCatalogSong[];
  href?: string;
  name?: string;
  next?: string;
  orderId?: string;
}

interface ChartsResponse {
  results?: {
    // Apple returns `songs` as an array of chart containers (e.g. one per chart
    // type within the requested type). We take the first container's `data`.
    songs?: ChartContainer[];
  };
}

/** Fetch the top N catalog songs from the storefront chart. Used by the
 * Phase 5 preflight's `apple_isrc_lookup` check to derive a known-good fixture
 * ISRC dynamically instead of hardcoding one (§11.1). */
export async function getTopChartSongs(limit = 1): Promise<AppleCatalogSong[]> {
  const storefront = await getStorefront();
  const url = `${API}/v1/catalog/${encodeURIComponent(storefront)}/charts?types=songs&limit=${limit}`;
  const r = await httpJson<ChartsResponse>({
    method: "GET",
    url,
    headers: devTokenHeaders(),
  });
  return r.results?.songs?.[0]?.data ?? [];
}

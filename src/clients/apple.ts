// Apple Music read client (Phase 3 surface).
//
// Every authenticated call carries BOTH headers per blueprint §5.2:
//   Authorization: Bearer <long-lived dev token>
//   Music-User-Token: <MUT>
//
// Storefront is resolved dynamically from `/v1/me/storefront` (never hardcoded
// — see §5.2). The result is cached for the lifetime of the process so we don't
// hit the endpoint on every catalog search; preflight re-resolves on each run.

import { forceResignDevToken, getLongLivedDevToken, getMut } from "../auth/apple.js";
import { httpJson, httpRequest, HttpError, type HttpRequest } from "../util/http.js";

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

/** Auth-failure handling shared by all authed reads (§11.1): reactive
 * dev-token re-sign on 401, and opt-in to the gate auto-invalidation sink.
 * (A 401 is more often a stale MUT than a stale dev token, which re-signing
 * can't fix — but the §11.1 contract is "one re-sign + retry", and if the
 * retry still 401s the gate invalidates, which is the correct outcome.) */
const AUTH_EXTRAS: Pick<HttpRequest, "onUnauthorized" | "reportAuthFailure"> = {
  reportAuthFailure: true,
  onUnauthorized: async () => {
    try {
      const token = forceResignDevToken();
      return { Authorization: `Bearer ${token}` };
    } catch {
      return undefined;
    }
  },
};

// ── Storefront ────────────────────────────────────────────────────────────

interface StorefrontResponse {
  data: { id: string; attributes?: { defaultLanguageTag?: string; supportedLanguageTags?: string[] } }[];
}

// Cache keyed on the current MUT (first 16 chars — enough to discriminate
// across reconnects without storing the full credential). When the user
// reconnects Apple with a different account (different storefront — US → JP),
// the MUT changes, the key misses, and we re-resolve. Without this, every
// catalog lookup keeps using the previous account's storefront and silently
// matches against the wrong region.
interface StorefrontCacheEntry {
  mutKey: string;
  storefront: string;
}
let storefrontCache: StorefrontCacheEntry | undefined;

function mutKey(): string {
  return getMut().slice(0, 16);
}

/** Returns the user's storefront id (e.g. "us"). Cached for the lifetime of
 * the current MUT — auto-invalidates on reconnect. */
export async function getStorefront(): Promise<string> {
  const key = mutKey();
  if (storefrontCache && storefrontCache.mutKey === key) {
    return storefrontCache.storefront;
  }
  const r = await httpJson<StorefrontResponse>({
    method: "GET",
    url: `${API}/v1/me/storefront`,
    headers: authedHeaders(),
      ...AUTH_EXTRAS,
  });
  const id = r.data[0]?.id;
  if (!id) throw new Error("apple_storefront_unresolved");
  storefrontCache = { mutKey: key, storefront: id };
  return id;
}

/** Test-only / explicit invalidation (kept for symmetry; auto-invalidation
 * via MUT-keyed cache handles normal reconnect flows). */
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
      ...AUTH_EXTRAS,
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

/** Single-page library playlists fetch (no pagination) — used by the Phase 5
 * preflight `apple_library_read` check, which only needs to prove the call
 * succeeds (§11.1: `GET /v1/me/library/playlists?limit=1`). */
export async function headLibraryPlaylists(limit = 1): Promise<number> {
  const r = await httpJson<{ data: AppleLibraryPlaylist[] }>({
    method: "GET",
    url: `${API}/v1/me/library/playlists?limit=${limit}`,
    headers: authedHeaders(),
      ...AUTH_EXTRAS,
  });
  return r.data.length;
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
  // Populated when ?include=catalog is sent (which we always do for library
  // reads). The catalog object holds the authoritative ISRC + contentRating
  // for matching; library wrappers do not expose `isrc` directly.
  readonly relationships?: {
    catalog?: {
      data: { id: string; type: "songs"; attributes?: { isrc?: string; name?: string; artistName?: string } }[];
    };
  };
}

/** Extract the ISRC for a library song, preferring the embedded catalog
 * relationship (the wire-level ISRC) over `attributes.isrc` (often absent
 * on library wrappers). Returns undefined when neither is populated —
 * Phase 4 matcher then drops to the Tier-2 scored-search fallback. */
export function libraryIsrc(s: AppleLibrarySong): string | undefined {
  return s.relationships?.catalog?.data?.[0]?.attributes?.isrc ?? s.attributes.isrc;
}

/** Extract the catalog song id for a library song. Prefers the relationship
 * (since `playParams.catalogId` doesn't ship with library-songs responses
 * unless `?include=catalog` is set, even though the type allows it). */
export function libraryCatalogId(s: AppleLibrarySong): string | undefined {
  return s.relationships?.catalog?.data?.[0]?.id ?? s.attributes.playParams?.catalogId;
}

export async function listLibraryPlaylistTracks(playlistId: string): Promise<AppleLibrarySong[]> {
  // ?include=catalog embeds the catalog song under relationships.catalog —
  // this is the only way to surface ISRC on library reads.
  try {
    return await paginate<AppleLibrarySong>(
      `/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100&include=catalog`,
      authedHeaders(),
    );
  } catch (err) {
    // Apple API hazard (§6): a playlist with ZERO tracks returns 404 on its
    // `/tracks` relationship — error code 40403 / "No related resources" —
    // instead of an empty list. That is NOT a failure: it means the
    // destination is empty, so the correct skip-set is []. Absorb ONLY that
    // specific shape; a genuinely-missing playlist (code 40400 / "Resource
    // Not Found") still propagates so we don't silently treat a typo'd id as
    // empty and then write the entire source into the wrong/nonexistent place.
    if (isEmptyRelationship404(err)) return [];
    throw err;
  }
}

/** True iff `err` is the Apple "this relationship has no members" 404 (an
 * empty playlist's tracks), as opposed to a missing-resource 404. Exported for
 * unit testing the discrimination. */
export function isEmptyRelationship404(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 404) return false;
  const body = err.body ?? "";
  return body.includes("40403") || /no related resources/i.test(body);
}

// ── Library songs (the "Library" collection — distinct from Favorites) ────

/** All songs the user has added to their library. The blueprint pairs the
 * Operation source `Liked/Favorites` to this collection on the Apple side;
 * if Apple's separate "favorited songs" endpoint is needed for the matching
 * model, it'll be added in Phase 7 when the Operation resolves the source.
 * See §6.3 — the favorite-a-song REST route has shifted and any read endpoint
 * must be verified against live Apple docs before wiring. */
export async function listLibrarySongs(): Promise<AppleLibrarySong[]> {
  return paginate<AppleLibrarySong>(
    "/v1/me/library/songs?limit=100&include=catalog",
    authedHeaders(),
  );
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

/** ISRC lookup per §7 Tier 1. Returns *all* candidates so the matcher can
 * disambiguate (multiple results across single/album/deluxe; some may 404
 * on a follow-up fetch — caller validates).
 *
 * A single ISRC can yield multiple catalog entries (single release, deluxe,
 * regional masters, compilation appearances). With 25 ISRCs per chunk and
 * Apple's modest default page size, responses can exceed one page — we MUST
 * follow `next` per chunk. The previous implementation pushed only the
 * first page of each chunk and silently dropped the rest, causing Phase 4's
 * matcher to miss candidates that should have disambiguated correctly. */
export async function searchByIsrc(isrcs: string[]): Promise<AppleCatalogSong[]> {
  if (isrcs.length === 0) return [];
  const storefront = await getStorefront();
  // Apple accepts up to 25 ISRCs per call (§7).
  const out: AppleCatalogSong[] = [];
  for (let i = 0; i < isrcs.length; i += 25) {
    const chunk = isrcs.slice(i, i + 25);
    const firstPath =
      `/v1/catalog/${encodeURIComponent(storefront)}/songs?` +
      `filter[isrc]=${chunk.map(encodeURIComponent).join(",")}&limit=100`;
    out.push(...(await paginate<AppleCatalogSong>(firstPath, devTokenHeaders())));
  }
  return out;
}

interface SearchResponse {
  results?: {
    songs?: { data: AppleCatalogSong[] };
  };
}

// Apple's catalog /search caps `limit` at 25.
const APPLE_SEARCH_MAX_LIMIT = 25;

/** Scored-search fallback per §7 Tier 2. Returns up to `limit` candidates;
 * the matcher scores and picks. Apple's `term=` is a free-text field (no
 * Spotify-style operator syntax), but we still strip control characters and
 * quotes for defense in depth, and clamp `limit` to Apple's max of 25. */
export async function searchCatalog(query: string, limit = APPLE_SEARCH_MAX_LIMIT): Promise<AppleCatalogSong[]> {
  // Strip double-quotes only; keep dashes/punctuation legitimately in titles (e.g. "Spider-Man").
  const safeTerm = query.replace(/["]/g, " ").replace(/\s+/g, " ").trim();
  if (safeTerm.length === 0) return [];
  const safeLimit = Math.min(Math.max(1, limit), APPLE_SEARCH_MAX_LIMIT);
  const storefront = await getStorefront();
  const url = `${API}/v1/catalog/${encodeURIComponent(storefront)}/search?term=${encodeURIComponent(safeTerm)}&types=songs&limit=${safeLimit}`;
  const r = await httpJson<SearchResponse>({
    method: "GET",
    url,
    headers: devTokenHeaders(),
      ...AUTH_EXTRAS,
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
      ...AUTH_EXTRAS,
  });
  return r.results?.songs?.[0]?.data ?? [];
}

// ── Writes (Phase 7) ────────────────────────────────────────────────────
//
// Endpoints verified live 2026-06-04 (blueprint §6.6). Add-tracks body is FLAT
// `{data:[{id,type:"songs"}]}` (over-nesting is the common 4xx); catalog song
// ids are accepted directly (no pre-add-to-library). Apple documents no batch
// max → conservative sequential batches. Writes may lag reads (handled by the
// §12.5 resume union).

export const APPLE_ADD_BATCH = 100;

function writeHeaders(): Record<string, string> {
  return { ...authedHeaders(), "Content-Type": "application/json" };
}

/** Create an empty library playlist (POST /v1/me/library/playlists). Returns
 * its `p.XXXX` library id. Tracks are added separately so we can batch. */
export async function createLibraryPlaylist(name: string, description = ""): Promise<string> {
  const r = await httpJson<{ data: { id: string }[] }>({
    method: "POST",
    url: `${API}/v1/me/library/playlists`,
    headers: writeHeaders(),
    body: JSON.stringify({ attributes: { name, description } }),
    ...AUTH_EXTRAS,
  });
  const id = r.data[0]?.id;
  if (!id) throw new Error("apple_create_playlist_no_id");
  return id;
}

/** Append catalog songs to a library playlist (append-only). Sequential
 * batches (no concurrent adds) per §6.1. */
export async function addTracksToLibraryPlaylist(playlistId: string, catalogSongIds: string[]): Promise<void> {
  for (let i = 0; i < catalogSongIds.length; i += APPLE_ADD_BATCH) {
    const chunk = catalogSongIds.slice(i, i + APPLE_ADD_BATCH);
    const r = await httpRequest({
      method: "POST",
      url: `${API}/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`,
      headers: writeHeaders(),
      body: JSON.stringify({ data: chunk.map((id) => ({ id, type: "songs" })) }),
      ...AUTH_EXTRAS,
    });
    if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, r.text, "apple_add_tracks");
  }
}

/** Favorite catalog songs (POST /v1/me/favorites?ids=…). One-way (no
 * un-favorite API). Re-favoriting is a harmless no-op, so this is safe to
 * call idempotently. */
export async function favoriteSongs(catalogSongIds: string[]): Promise<void> {
  for (let i = 0; i < catalogSongIds.length; i += APPLE_ADD_BATCH) {
    const chunk = catalogSongIds.slice(i, i + APPLE_ADD_BATCH);
    const url = `${API}/v1/me/favorites?ids=${chunk.map(encodeURIComponent).join(",")}`;
    const r = await httpRequest({ method: "POST", url, headers: authedHeaders(), ...AUTH_EXTRAS });
    if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, r.text, "apple_favorite");
  }
}

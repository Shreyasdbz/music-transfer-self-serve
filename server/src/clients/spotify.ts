// Spotify read client (Phase 2 surface).
// Writes land in Phase 7 alongside the Operation runner.
//
// All requests go through util/http.ts; auth header injected from
// auth/spotify.ts's `getAccessToken`. Pagination uses Spotify's `next` URL
// when present, capped at a high but finite limit (defense against runaway
// loops on a buggy server response).

import { forceRefreshAccessToken, getAccessToken } from "../auth/spotify.js";
import { httpJson, httpRequest, HttpError, type HttpRequest } from "../util/http.js";

const API = "https://api.spotify.com";
const MAX_PAGES = 200; // 200 * 50 = 10 000 items max per collection — enough for a personal library

async function bearer(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

/** Auth-failure handling shared by all authed reads (§11.1): reactive
 * refresh-on-401, and opt-in to the gate auto-invalidation sink. Spread into
 * each httpJson call alongside `headers`. */
const AUTH_EXTRAS: Pick<HttpRequest, "onUnauthorized" | "reportAuthFailure"> = {
  reportAuthFailure: true,
  onUnauthorized: async () => {
    try {
      const token = await forceRefreshAccessToken();
      return { Authorization: `Bearer ${token}` };
    } catch {
      return undefined; // refresh failed → surface 401 → gate invalidates
    }
  },
};

export interface SpotifyProfile {
  readonly id: string;
  readonly display_name: string | null;
  readonly country?: string;
}

export async function getMe(): Promise<SpotifyProfile> {
  return httpJson<SpotifyProfile>({
    method: "GET",
    url: `${API}/v1/me`,
    headers: await bearer(),
    ...AUTH_EXTRAS,
  });
}

// Note (2026-06): Spotify renamed the playlist's `tracks` field to `items` on
// the playlist object — both on the listing endpoint and on the single-playlist
// endpoint. The track count is now at `items.total`. We accept either shape so
// the client survives Spotify rolling the rename back, or any client (e.g.
// `/v1/me/tracks` for Saved Tracks) that still emits the legacy field.
export interface SpotifyPlaylistSummary {
  readonly id: string;
  readonly name: string;
  readonly owner: { id: string; display_name?: string | null };
  readonly items?: { total: number; href?: string };
  readonly tracks?: { total: number; href?: string };
  readonly external_urls: { spotify?: string };
}

export function playlistTrackCount(p: SpotifyPlaylistSummary): number | undefined {
  return p.items?.total ?? p.tracks?.total;
}

interface Page<T> {
  items: T[];
  next: string | null;
}

async function paginate<T>(firstUrl: string): Promise<T[]> {
  const headers = await bearer();
  const out: T[] = [];
  let nextUrl: string | null = firstUrl;
  let pages = 0;
  while (nextUrl && pages < MAX_PAGES) {
    const page: Page<T> = await httpJson<Page<T>>({
      method: "GET",
      url: nextUrl,
      headers,
      ...AUTH_EXTRAS,
    });
    out.push(...page.items);
    nextUrl = page.next;
    pages++;
  }
  return out;
}

export async function listMyPlaylists(): Promise<SpotifyPlaylistSummary[]> {
  return paginate<SpotifyPlaylistSummary>(`${API}/v1/me/playlists?limit=50`);
}

export interface SpotifyTrack {
  readonly id: string;
  readonly name: string;
  readonly artists: { id: string; name: string }[];
  readonly album: { id: string; name: string };
  readonly duration_ms: number;
  readonly explicit: boolean;
  readonly external_ids?: { isrc?: string };
}

// As of 2026-06, the playlist endpoint returns items whose payload is keyed
// `item` (singular), not `track` (legacy). We accept both shapes — the legacy
// path still works for `/v1/me/tracks` (Saved Tracks) and for any Spotify
// surface that hasn't migrated yet.
interface PlaylistTrackItem {
  item?: SpotifyTrack | null;
  track?: SpotifyTrack | null;
}

function extractTrack(it: PlaylistTrackItem): SpotifyTrack | null {
  return it.item ?? it.track ?? null;
}

interface SavedTrackItem {
  track: SpotifyTrack;
}

/**
 * Reads a playlist's tracks.
 *
 * Endpoint note (verified 2026-06): Spotify renamed the playlist-tracks
 * subpath from `/v1/playlists/{id}/tracks` to `/v1/playlists/{id}/items` and
 * the inner field from `track` to `item`. The old `/tracks` URL now returns
 * 403 Forbidden (not gone — just rejected, presumably to push clients off the
 * legacy shape). The new `/items` endpoint accepts the same query params
 * (`limit`, `offset`, `market`, `fields`) and returns the same Page<T> shape.
 * `extractTrack` accepts both `item` and `track` field names so a future
 * roll-back doesn't break us.
 */
export async function listPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]> {
  const items = await paginate<PlaylistTrackItem>(
    `${API}/v1/playlists/${encodeURIComponent(playlistId)}/items?limit=50&market=from_token`,
  );
  return items.map(extractTrack).filter((t): t is SpotifyTrack => t !== null);
}

export async function listSavedTracks(): Promise<SpotifyTrack[]> {
  const items = await paginate<SavedTrackItem>(`${API}/v1/me/tracks?limit=50`);
  return items.map((i) => i.track);
}

/** Cheap count of the user's Liked Songs — `GET /v1/me/tracks?limit=1`
 * returns `{ total }` without fetching the collection. Used by the catalog
 * refresh to populate the Liked-Songs row's track_count. */
export async function getSavedTracksTotal(): Promise<number> {
  const r = await httpJson<{ total: number }>({
    method: "GET",
    url: `${API}/v1/me/tracks?limit=1`,
    headers: await bearer(),
    ...AUTH_EXTRAS,
  });
  return r.total ?? 0;
}

// ── Catalog search (Tier-1 / Tier-2 matching) ──────────────────────────

interface SearchResponse {
  tracks?: { items: SpotifyTrack[] };
}

// Spotify's /v1/search caps `limit` at 10 (default 5) — values above 10
// return 400. (https://developer.spotify.com/documentation/web-api/reference/search)
const SPOTIFY_SEARCH_MAX_LIMIT = 10;

/** Strip Spotify search field-operators from a free-text term so a track
 * title like `Bad OR isrc:GBUM71029601` or `X track:"Wonderwall"` can't
 * hijack the query into pulling unrelated recordings. `encodeURIComponent`
 * URL-encodes but does NOT neutralize Spotify's `q=` operator syntax. */
export function sanitizeSearchTerm(term: string): string {
  return term
    .replace(/["':]/g, " ")
    .replace(/\b(?:AND|OR|NOT|track|artist|album|isrc|year|tag|genre|upc|label)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Why no `market` param: a validation pass suggested adding `market=from_token`
// (the docs note catalog availability can vary by market). But `from_token`
// requires the `user-read-private` scope to resolve the user's country, and
// our §5.1 scope set deliberately omits it. Adding the param returns
// `403 Insufficient client scope` (verified live 2026-06-04). For a
// user-authorized token, Spotify already scopes catalog availability to the
// authenticated user without an explicit market, so we omit it rather than
// broaden our scopes. (The market concern is really about app-only / client-
// credentials tokens, which we don't use.)

/** Tier-1 Apple→Spotify match. Spotify accepts `q=isrc:CODE` and returns the
 * recording(s) carrying that ISRC. Multiple results are possible (same
 * recording across single/album/deluxe); the matcher disambiguates.
 *
 * Important: Spotify's `q=isrc:` search rejects `limit` > 1 with
 * `400 Invalid limit` (verified live 2026-06-04). Omitting `limit` returns
 * Spotify's default — enough to disambiguate. */
export async function searchTracksByIsrc(isrc: string): Promise<SpotifyTrack[]> {
  const url = `${API}/v1/search?q=${encodeURIComponent(`isrc:${isrc}`)}&type=track`;
  const r = await httpJson<SearchResponse>({
    method: "GET",
    url,
    headers: await bearer(),
    ...AUTH_EXTRAS,
  });
  return r.tracks?.items ?? [];
}

/** Tier-2 scored search. `term` is typically "<title> <primary artist>";
 * it's sanitized of Spotify field-operators first. `limit` is clamped to
 * Spotify's documented max of 10. */
export async function searchTracks(
  term: string,
  limit = SPOTIFY_SEARCH_MAX_LIMIT,
): Promise<SpotifyTrack[]> {
  const safeLimit = Math.min(Math.max(1, limit), SPOTIFY_SEARCH_MAX_LIMIT);
  const safeTerm = sanitizeSearchTerm(term);
  if (safeTerm.length === 0) return [];
  const url = `${API}/v1/search?q=${encodeURIComponent(safeTerm)}&type=track&limit=${safeLimit}`;
  const r = await httpJson<SearchResponse>({
    method: "GET",
    url,
    headers: await bearer(),
    ...AUTH_EXTRAS,
  });
  return r.tracks?.items ?? [];
}

// ── Writes (Phase 7) ────────────────────────────────────────────────────
//
// Endpoints verified live 2026-06-04 (blueprint §6.6) — Spotify's Feb-2026
// migration renamed all of these. Batch caps: add-to-playlist 100, save 40,
// contains 40. Bodies use `uris` (spotify:track:ID), NOT `ids`.

export const SPOTIFY_ADD_BATCH = 100;
export const SPOTIFY_SAVE_BATCH = 40;
export const SPOTIFY_CONTAINS_BATCH = 40;

function trackUri(id: string): string {
  return `spotify:track:${id}`;
}

async function writeHeaders(): Promise<Record<string, string>> {
  return { ...(await bearer()), "Content-Type": "application/json" };
}

/** Create a new private playlist (POST /v1/me/playlists). Returns its id. */
export async function createPlaylist(name: string, description = ""): Promise<string> {
  const r = await httpJson<{ id: string }>({
    method: "POST",
    url: `${API}/v1/me/playlists`,
    headers: await writeHeaders(),
    body: JSON.stringify({ name, public: false, description }),
    ...AUTH_EXTRAS,
  });
  return r.id;
}

/** Append track ids to a playlist (POST /v1/playlists/{id}/items). Chunks at
 * 100. Caller passes bare track ids; we wrap them as spotify:track URIs. */
export async function addItemsToPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
  for (let i = 0; i < trackIds.length; i += SPOTIFY_ADD_BATCH) {
    const chunk = trackIds.slice(i, i + SPOTIFY_ADD_BATCH);
    const r = await httpRequest({
      method: "POST",
      url: `${API}/v1/playlists/${encodeURIComponent(playlistId)}/items`,
      headers: await writeHeaders(),
      body: JSON.stringify({ uris: chunk.map(trackUri) }),
      ...AUTH_EXTRAS,
    });
    if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, r.text, "add_items");
  }
}

/** Save tracks to the user's library / Liked Songs (PUT /v1/me/library).
 * Chunks at 40. */
export async function saveToLibrary(trackIds: string[]): Promise<void> {
  for (let i = 0; i < trackIds.length; i += SPOTIFY_SAVE_BATCH) {
    const chunk = trackIds.slice(i, i + SPOTIFY_SAVE_BATCH);
    const r = await httpRequest({
      method: "PUT",
      url: `${API}/v1/me/library`,
      headers: await writeHeaders(),
      body: JSON.stringify({ uris: chunk.map(trackUri) }),
      ...AUTH_EXTRAS,
    });
    if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, r.text, "save_library");
  }
}

/** Check which of `trackIds` are already saved (GET /v1/me/library/contains).
 * Returns the set of saved ids. Chunks at 40. */
export async function savedContains(trackIds: string[]): Promise<Set<string>> {
  const saved = new Set<string>();
  for (let i = 0; i < trackIds.length; i += SPOTIFY_CONTAINS_BATCH) {
    const chunk = trackIds.slice(i, i + SPOTIFY_CONTAINS_BATCH);
    const url = `${API}/v1/me/library/contains?uris=${chunk.map((id) => encodeURIComponent(trackUri(id))).join(",")}`;
    const flags = await httpJson<boolean[]>({
      method: "GET",
      url,
      headers: await bearer(),
      ...AUTH_EXTRAS,
    });
    chunk.forEach((id, idx) => {
      if (flags[idx]) saved.add(id);
    });
  }
  return saved;
}

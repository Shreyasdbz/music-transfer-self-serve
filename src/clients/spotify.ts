// Spotify read client (Phase 2 surface).
// Writes land in Phase 7 alongside the Operation runner.
//
// All requests go through util/http.ts; auth header injected from
// auth/spotify.ts's `getAccessToken`. Pagination uses Spotify's `next` URL
// when present, capped at a high but finite limit (defense against runaway
// loops on a buggy server response).

import { getAccessToken } from "../auth/spotify.js";
import { httpJson } from "../util/http.js";

const API = "https://api.spotify.com";
const MAX_PAGES = 200; // 200 * 50 = 10 000 items max per collection — enough for a personal library

async function bearer(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

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
  });
}

export interface SpotifyPlaylistSummary {
  readonly id: string;
  readonly name: string;
  readonly owner: { id: string; display_name?: string | null };
  readonly tracks: { total: number };
  readonly external_urls: { spotify?: string };
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
    const page: Page<T> = await httpJson<Page<T>>({ method: "GET", url: nextUrl, headers });
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

interface PlaylistWithItems {
  items: Page<PlaylistTrackItem>;
}

/**
 * Reads a playlist's tracks.
 *
 * Implementation note (observed 2026-06): Spotify returns 403 Forbidden on the
 * dedicated `/v1/playlists/{id}/tracks` endpoint for apps in Development Mode
 * quota — same token, same scopes, same playlist where `/v1/playlists/{id}`
 * itself returns 200. The same paging data is reachable via the parent endpoint
 * under a field named `items` (Spotify also appears to have renamed the
 * legacy `tracks` field to `items` on the playlist object). We therefore:
 *   - fetch the first page via `/v1/playlists/{id}` and read `items.items[].track`
 *   - paginate via `items.next` if present
 *
 * If `items.next` points back at the restricted `/tracks` endpoint and 403s,
 * we surface that to the caller — Phase 5 preflight will catch this and
 * Phase 7 will need a workaround (likely: walk pages by re-fetching the parent
 * with `?offset=...&fields=items.items(...),items.next`). Documented as a
 * Phase 7 risk in PROGRESS.md.
 */
export async function listPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]> {
  const first = await httpJson<PlaylistWithItems>({
    method: "GET",
    url: `${API}/v1/playlists/${encodeURIComponent(playlistId)}?market=from_token`,
    headers: await bearer(),
  });
  const out: PlaylistTrackItem[] = [...first.items.items];
  let url = first.items.next;
  let pages = 1;
  while (url && pages < MAX_PAGES) {
    const page: Page<PlaylistTrackItem> = await httpJson<Page<PlaylistTrackItem>>({
      method: "GET",
      url,
      headers: await bearer(),
    });
    out.push(...page.items);
    url = page.next;
    pages++;
  }
  return out.map(extractTrack).filter((t): t is SpotifyTrack => t !== null);
}

export async function listSavedTracks(): Promise<SpotifyTrack[]> {
  const items = await paginate<SavedTrackItem>(`${API}/v1/me/tracks?limit=50`);
  return items.map((i) => i.track);
}

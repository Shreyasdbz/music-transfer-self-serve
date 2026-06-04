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

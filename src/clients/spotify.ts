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

interface PlaylistTrackItem {
  track: SpotifyTrack | null; // local files / deleted tracks come through null
}

interface SavedTrackItem {
  track: SpotifyTrack;
}

export async function listPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]> {
  const items = await paginate<PlaylistTrackItem>(
    `${API}/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=50`,
  );
  return items.map((i) => i.track).filter((t): t is SpotifyTrack => t !== null);
}

export async function listSavedTracks(): Promise<SpotifyTrack[]> {
  const items = await paginate<SavedTrackItem>(`${API}/v1/me/tracks?limit=50`);
  return items.map((i) => i.track);
}

// Spotify provider — wraps the existing read/write client + the Spotify⇆canonical
// adapter behind the MusicProvider interface. All Spotify-specific knowledge
// (single-ISRC search, liked-set is readable, 100/40 batch caps) lives here so
// the engine never branches on `=== "spotify"`.

import {
  listPlaylistTracks,
  listSavedTracks,
  searchTracksByIsrc,
  searchTracks,
  createPlaylist,
  addItemsToPlaylist,
  saveToLibrary,
  SPOTIFY_ADD_BATCH,
  SPOTIFY_SAVE_BATCH,
  type SpotifyTrack,
} from "../../clients/spotify.js";
import { normIsrc, type CanonicalTrack } from "../../match/identity.js";
import type { DestTrack, MusicProvider, ProviderCapabilities, UserCtx } from "../types.js";
import type { ResolvedTarget } from "../../operation/types.js";

/** Tier-2 candidate-pool size. Spotify's /v1/search caps `limit` at 10. */
const SPOTIFY_SEARCH_LIMIT = 10;

/** Spotify track → canonical. (Moved here from match/matcher.ts; the provider
 * owns the adapter so the matcher stays platform-agnostic.) */
export function spotifyToCanonical(t: SpotifyTrack): CanonicalTrack {
  return {
    isrc: normIsrc(t.external_ids?.isrc),
    title: t.name,
    primaryArtist: t.artists[0]?.name ?? "",
    artists: t.artists.map((a) => a.name),
    album: t.album?.name,
    durationMs: t.duration_ms,
    explicit: t.explicit,
    source: "spotify",
    sourceId: t.id,
  };
}

const capabilities: ProviderCapabilities = {
  supportsIsrc: true,
  likedKind: "liked",
  likedReadable: true, // Spotify's saved-tracks set IS readable → accurate skip set
  supportsLikedRemoval: false,
  canCreatePlaylist: true,
  playlistAppendOnly: false,
  writeBatchAdd: SPOTIFY_ADD_BATCH,
  writeBatchLike: SPOTIFY_SAVE_BATCH,
  searchLimit: SPOTIFY_SEARCH_LIMIT,
};

export const spotifyProvider: MusicProvider = {
  id: "spotify",
  displayName: "Spotify",
  capabilities,

  async readSourceTracks(_ctx: UserCtx, target: ResolvedTarget): Promise<CanonicalTrack[]> {
    if (target.kind === "liked") return (await listSavedTracks()).map(spotifyToCanonical);
    if (target.kind === "playlist") return (await listPlaylistTracks(target.id)).map(spotifyToCanonical);
    throw new Error("invalid_spotify_source_target");
  },

  async readDestinationTracks(_ctx: UserCtx, target: ResolvedTarget): Promise<DestTrack[]> {
    if (target.kind === "create") return [];
    // Spotify Liked Songs IS the saved set, so listSavedTracks is an accurate
    // skip set; the write id is the track id.
    const tracks = target.kind === "playlist" ? await listPlaylistTracks(target.id) : await listSavedTracks();
    return tracks.map((t) => ({ canonical: spotifyToCanonical(t), destId: t.id }));
  },

  async searchByIsrc(_ctx: UserCtx, isrcs: readonly string[]): Promise<CanonicalTrack[]> {
    const isrc = isrcs[0];
    if (!isrc) return []; // Spotify's q=isrc: search takes one code at a time
    return (await searchTracksByIsrc(isrc)).map(spotifyToCanonical);
  },

  async searchByTerm(_ctx: UserCtx, term: string, limit: number): Promise<CanonicalTrack[]> {
    return (await searchTracks(term, limit)).map(spotifyToCanonical);
  },

  async createPlaylistNamed(_ctx: UserCtx, name: string): Promise<string> {
    return createPlaylist(name);
  },

  async writeTracks(
    _ctx: UserCtx,
    target: ResolvedTarget,
    playlistId: string | undefined,
    destIds: readonly string[],
  ): Promise<void> {
    if (destIds.length === 0) return;
    const ids = [...destIds];
    if (target.kind === "liked") return saveToLibrary(ids);
    if (!playlistId) throw new Error("missing_destination_playlist_id");
    return addItemsToPlaylist(playlistId, ids);
  },
};

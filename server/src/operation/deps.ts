// The injectable client surface the Operation runner depends on. Defaults wire
// the real read/write clients + the Phase-4 matcher; tests swap in fakes via
// __setOperationDeps so the runner's logic (skip / match / write / resume) is
// exercised with ZERO real API calls.

import type { CanonicalTrack } from "../match/identity.js";
import type { MatchResult } from "../match/matcher.js";
import {
  appleLibraryToCanonical,
  appleLibraryCatalogId,
  matchAppleToSpotify,
  matchSpotifyToApple,
  spotifyToCanonical,
} from "../match/matcher.js";
import { identityKey } from "../match/identity.js";
import { deleteCachedTrack } from "../ledger/tracksCache.js";
import {
  listPlaylistTracks,
  listSavedTracks,
  createPlaylist as spCreatePlaylist,
  addItemsToPlaylist,
  saveToLibrary,
} from "../clients/spotify.js";
import {
  listLibraryPlaylistTracks,
  listLibrarySongs,
  createLibraryPlaylist,
  addTracksToLibraryPlaylist,
  favoriteSongs,
} from "../clients/apple.js";
import type { OperationSpec, Platform, ResolvedTarget } from "./types.js";

export interface DestTrack {
  readonly canonical: CanonicalTrack;
  /** Destination-platform id used for matching/writing: Spotify track id, or
   * Apple CATALOG song id (what writes use). */
  readonly destId: string;
}

export interface OperationDeps {
  readSource(source: Platform, target: ResolvedTarget): Promise<CanonicalTrack[]>;
  readDestination(destination: Platform, target: ResolvedTarget): Promise<DestTrack[]>;
  createDestination(destination: Platform, name: string): Promise<string>; // new playlist id
  match(source: CanonicalTrack, useCache: boolean): Promise<MatchResult>;
  deleteCache(source: CanonicalTrack): void;
  writeTracks(
    destination: Platform,
    target: ResolvedTarget,
    playlistId: string | undefined,
    destIds: string[],
  ): Promise<void>;
}

// ── Real implementations ─────────────────────────────────────────────────

async function readSource(source: Platform, target: ResolvedTarget): Promise<CanonicalTrack[]> {
  if (source === "spotify") {
    if (target.kind === "liked") return (await listSavedTracks()).map(spotifyToCanonical);
    if (target.kind === "playlist") return (await listPlaylistTracks(target.id)).map(spotifyToCanonical);
    throw new Error("invalid_spotify_source_target");
  }
  if (target.kind === "favorites") return (await listLibrarySongs()).map(appleLibraryToCanonical);
  if (target.kind === "playlist") return (await listLibraryPlaylistTracks(target.id)).map(appleLibraryToCanonical);
  throw new Error("invalid_apple_source_target");
}

async function readDestination(destination: Platform, target: ResolvedTarget): Promise<DestTrack[]> {
  if (target.kind === "create") return []; // brand-new playlist
  if (destination === "spotify") {
    // Liked Songs is read directly via listSavedTracks — that IS the saved
    // set, so the skip-if-present check is accurate.
    const tracks = target.kind === "playlist" ? await listPlaylistTracks(target.id) : await listSavedTracks();
    return tracks.map((t) => ({ canonical: spotifyToCanonical(t), destId: t.id }));
  }
  if (target.kind === "playlist") {
    const songs = await listLibraryPlaylistTracks(target.id);
    return songs.map((s) => ({ canonical: appleLibraryToCanonical(s), destId: appleLibraryCatalogId(s) ?? s.id }));
  }
  // Apple FAVORITES destination: Apple exposes no wired "favorited-songs" READ
  // endpoint (§6.3), and the whole-library read (listLibrarySongs) is the WRONG
  // skip set — a library song that isn't favorited would be wrongly skipped and
  // never favorited. So we return an EMPTY D: every matched track is favorited.
  // This is safe because favoriting is idempotent (re-favorite is a harmless
  // no-op, §6.6), and same-tuple re-runs are still suppressed by the §12.5
  // resume union (priorWrittenDestIds for the stable {kind:favorites} tuple).
  return [];
}

async function createDestination(destination: Platform, name: string): Promise<string> {
  return destination === "spotify" ? spCreatePlaylist(name) : createLibraryPlaylist(name);
}

async function match(source: CanonicalTrack, useCache: boolean): Promise<MatchResult> {
  return source.source === "spotify"
    ? matchSpotifyToApple(source, { useCache })
    : matchAppleToSpotify(source, { useCache });
}

function deleteCache(source: CanonicalTrack): void {
  deleteCachedTrack(identityKey(source));
}

async function writeTracks(
  destination: Platform,
  target: ResolvedTarget,
  playlistId: string | undefined,
  destIds: string[],
): Promise<void> {
  if (destIds.length === 0) return;
  if (destination === "spotify") {
    if (target.kind === "liked") return saveToLibrary(destIds);
    if (!playlistId) throw new Error("missing_destination_playlist_id");
    return addItemsToPlaylist(playlistId, destIds);
  }
  if (target.kind === "favorites") return favoriteSongs(destIds);
  if (!playlistId) throw new Error("missing_destination_playlist_id");
  return addTracksToLibraryPlaylist(playlistId, destIds);
}

const REAL_DEPS: OperationDeps = {
  readSource,
  readDestination,
  createDestination,
  match,
  deleteCache,
  writeTracks,
};

let deps: OperationDeps = REAL_DEPS;

export function getOperationDeps(): OperationDeps {
  return deps;
}

/** Test-only: override the dep surface. */
export function __setOperationDeps(overrides: Partial<OperationDeps>): void {
  deps = { ...REAL_DEPS, ...overrides };
}
export function __resetOperationDeps(): void {
  deps = REAL_DEPS;
}

export type { OperationSpec };

// Apple Music provider — wraps the existing read/write client + the Apple⇆canonical
// adapters behind the MusicProvider interface. All Apple-specific knowledge
// (library-vs-catalog ids, favorites are NOT readable, append-only writes, the
// empty-playlist 40403 absorbed inside the client) lives here.

import {
  listLibraryPlaylistTracks,
  listLibrarySongs,
  searchByIsrc as appleSearchByIsrc,
  searchCatalog,
  createLibraryPlaylist,
  addTracksToLibraryPlaylist,
  favoriteSongs,
  libraryIsrc,
  libraryCatalogId,
  APPLE_ADD_BATCH,
  type AppleCatalogSong,
  type AppleLibrarySong,
} from "../../clients/apple.js";
import { normIsrc, type CanonicalTrack } from "../../match/identity.js";
import type { DestTrack, MusicProvider, ProviderCapabilities, UserCtx } from "../types.js";
import type { ResolvedTarget } from "../../operation/types.js";

/** Tier-2 candidate-pool size (Apple allows larger pages than Spotify). */
const APPLE_SEARCH_LIMIT = 25;

/** Apple CATALOG song → canonical. `contentRating` absent ⇒ explicit:undefined
 * (unknown), NOT false — otherwise a Spotify source with explicit=false would
 * spuriously earn the +10 explicit-match bonus against an unrated Apple song. */
export function appleCatalogToCanonical(t: AppleCatalogSong): CanonicalTrack {
  const explicit =
    t.attributes.contentRating === undefined
      ? undefined
      : t.attributes.contentRating === "explicit";
  return {
    isrc: normIsrc(t.attributes.isrc),
    title: t.attributes.name,
    primaryArtist: t.attributes.artistName,
    artists: [t.attributes.artistName],
    album: t.attributes.albumName,
    durationMs: t.attributes.durationInMillis,
    explicit,
    source: "apple",
    sourceId: t.id,
  };
}

/** Apple LIBRARY song → canonical (source side when Apple is the source). ISRC
 * comes from the embedded catalog relationship (`?include=catalog`); `sourceId`
 * is the LIBRARY id we read. */
export function appleLibraryToCanonical(s: AppleLibrarySong): CanonicalTrack {
  const rating = s.attributes.contentRating;
  return {
    isrc: normIsrc(libraryIsrc(s)),
    title: s.attributes.name,
    primaryArtist: s.attributes.artistName,
    artists: [s.attributes.artistName],
    album: s.attributes.albumName,
    durationMs: s.attributes.durationInMillis,
    explicit: rating === undefined ? undefined : rating === "explicit",
    source: "apple",
    sourceId: s.id,
  };
}

const capabilities: ProviderCapabilities = {
  supportsIsrc: true,
  likedKind: "favorites",
  // Apple exposes no reliable "favorited songs" READ; the whole-library read is
  // the WRONG skip set. So favorites are NOT readable → empty-D, which is
  // additive-safe (favoriting is idempotent; the §12.5 resume union dedupes).
  likedReadable: false,
  supportsLikedRemoval: false,
  canCreatePlaylist: true,
  playlistAppendOnly: true, // §6.1 add-to-end only, sequential batches
  writeBatchAdd: APPLE_ADD_BATCH,
  writeBatchLike: APPLE_ADD_BATCH,
  searchLimit: APPLE_SEARCH_LIMIT,
};

export const appleProvider: MusicProvider = {
  id: "apple",
  displayName: "Apple Music",
  capabilities,

  async readSourceTracks(_ctx: UserCtx, target: ResolvedTarget): Promise<CanonicalTrack[]> {
    if (target.kind === "favorites") return (await listLibrarySongs()).map(appleLibraryToCanonical);
    if (target.kind === "playlist")
      return (await listLibraryPlaylistTracks(target.id)).map(appleLibraryToCanonical);
    throw new Error("invalid_apple_source_target");
  },

  async readDestinationTracks(_ctx: UserCtx, target: ResolvedTarget): Promise<DestTrack[]> {
    if (target.kind === "create") return [];
    if (target.kind === "playlist") {
      const songs = await listLibraryPlaylistTracks(target.id);
      // Write id is the CATALOG id (what add-tracks uses), falling back to the
      // library id when the catalog relationship is absent.
      return songs.map((s) => ({
        canonical: appleLibraryToCanonical(s),
        destId: libraryCatalogId(s) ?? s.id,
      }));
    }
    // favorites destination: not readable (see likedReadable) → empty D.
    return [];
  },

  async searchByIsrc(_ctx: UserCtx, isrcs: readonly string[]): Promise<CanonicalTrack[]> {
    if (isrcs.length === 0) return [];
    return (await appleSearchByIsrc([...isrcs])).map(appleCatalogToCanonical);
  },

  async searchByTerm(_ctx: UserCtx, term: string, limit: number): Promise<CanonicalTrack[]> {
    return (await searchCatalog(term, limit)).map(appleCatalogToCanonical);
  },

  async createPlaylistNamed(_ctx: UserCtx, name: string): Promise<string> {
    return createLibraryPlaylist(name);
  },

  async writeTracks(
    _ctx: UserCtx,
    target: ResolvedTarget,
    playlistId: string | undefined,
    destIds: readonly string[],
  ): Promise<void> {
    if (destIds.length === 0) return;
    const ids = [...destIds];
    if (target.kind === "favorites") return favoriteSongs(ids);
    if (!playlistId) throw new Error("missing_destination_playlist_id");
    return addTracksToLibraryPlaylist(playlistId, ids);
  },
};

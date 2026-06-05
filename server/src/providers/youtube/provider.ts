// YouTube Music — PLACEHOLDER provider (deferred to a future iteration).
//
// This registers so YouTube Music appears in the UI (auth row, catalog card,
// disabled in the transfer dropdowns), but it is intentionally NON-FUNCTIONAL:
// `available: false` keeps the engine and the UI from ever selecting it as a
// transfer source or destination, and every read/write method throws a clear
// `provider_unavailable` error as a safety net if it is ever reached.
//
// When YouTube is implemented for real (official YouTube Data API v3, OAuth, no
// ISRC → Tier-2 title/artist matching only, additive-only via videos.rate /
// playlistItems.insert), replace these stubs and flip `available` to true.
// The capability flags below already describe that future shape honestly.

import type { CanonicalTrack } from "../../match/identity.js";
import type { DestTrack, MusicProvider, ProviderCapabilities, UserCtx } from "../types.js";

const UNAVAILABLE = "provider_unavailable:youtube — YouTube Music support is coming in a future update.";

/** Honest forward-looking capabilities: no ISRC (Tier-2 only), liked set not
 * readable via API, append-only playlist writes, additive-only. Sizes are 0
 * while unimplemented so nothing tries to batch against it. */
const capabilities: ProviderCapabilities = {
  supportsIsrc: false,
  likedKind: "liked",
  likedReadable: false,
  supportsLikedRemoval: false,
  canCreatePlaylist: false,
  playlistAppendOnly: true,
  writeBatchAdd: 0,
  writeBatchLike: 0,
  searchLimit: 0,
};

export const youtubeProvider: MusicProvider = {
  id: "youtube",
  displayName: "YouTube Music",
  capabilities,
  available: false,

  readSourceTracks(_ctx: UserCtx): Promise<CanonicalTrack[]> {
    return Promise.reject(new Error(UNAVAILABLE));
  },
  readDestinationTracks(_ctx: UserCtx): Promise<DestTrack[]> {
    return Promise.reject(new Error(UNAVAILABLE));
  },
  searchByIsrc(_ctx: UserCtx): Promise<CanonicalTrack[]> {
    return Promise.reject(new Error(UNAVAILABLE));
  },
  searchByTerm(_ctx: UserCtx): Promise<CanonicalTrack[]> {
    return Promise.reject(new Error(UNAVAILABLE));
  },
  createPlaylistNamed(_ctx: UserCtx): Promise<string> {
    return Promise.reject(new Error(UNAVAILABLE));
  },
  writeTracks(_ctx: UserCtx): Promise<void> {
    return Promise.reject(new Error(UNAVAILABLE));
  },
};

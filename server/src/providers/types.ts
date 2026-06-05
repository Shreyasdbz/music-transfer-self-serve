// The MusicProvider abstraction (blueprint v2 / todo.md §B). One interface +
// registry replaces the ~30 hardcoded `"spotify" | "apple"` branch points so a
// third provider (YouTube Music, phase V7) is drop-in. Each provider wraps its
// own auth + read/write clients and owns its platform quirks (Apple's
// empty-playlist 40403, append-only writes, favorites-not-readable, etc.),
// exposing them to the engine only through `capabilities`.
//
// Phase V1 defines the operation + match surface that the runner/deps/matcher
// need. Auth-status, catalog-refresh, and preflight slices are added to this
// interface in later phases when those routes are generalized.

import type { CanonicalTrack } from "../match/identity.js";
import type { ResolvedTarget } from "../operation/types.js";

/** A provider identifier — `"spotify"`, `"apple"`, `"youtube"`, … A plain
 * string (not a closed union) so adding a provider needs no type edit here. */
export type ProviderId = string;

/** Per-request user context. Single-owner today (`__owner__`); every provider
 * method takes it so per-user token isolation (phase V2+) drops in with zero
 * signature changes. */
export interface UserCtx {
  readonly userId: string;
}

/** The singleton owner used everywhere in v2 until the multi-user seam (A2) is
 * activated. */
export const OWNER: UserCtx = { userId: "__owner__" };

/** Static facts about a provider that let the engine branch on behavior instead
 * of on a platform string. */
export interface ProviderCapabilities {
  /** Does this provider expose ISRC (Tier-1 matching)? YouTube: false → Tier-2
   * title/artist only. */
  readonly supportsIsrc: boolean;
  /** The provider's "saved tracks" collection kind. */
  readonly likedKind: "liked" | "favorites" | "none";
  /** Can the liked/favorites set be ENUMERATED to build a skip set? Spotify:
   * true. Apple favorites / YouTube LL: false → empty-D + ledger idempotency. */
  readonly likedReadable: boolean;
  /** Additive-only invariant, encoded in the type system: no provider may ever
   * expose a liked/favorites removal. Always the literal `false`. */
  readonly supportsLikedRemoval: false;
  /** Can this provider create a new playlist on the destination side? */
  readonly canCreatePlaylist: boolean;
  /** Playlist writes only append to the end, no insert/reorder (Apple, YouTube). */
  readonly playlistAppendOnly: boolean;
  /** Max ids per playlist-add request (the runner chunks at this size). */
  readonly writeBatchAdd: number;
  /** Max ids per liked/favorites write request. */
  readonly writeBatchLike: number;
  /** Tier-2 candidate-pool size the matcher requests from this provider. */
  readonly searchLimit: number;
}

/** A destination-side track plus the id used to WRITE it (Spotify track id,
 * Apple catalog song id, YouTube video id) — which can differ from the
 * canonical `sourceId` (e.g. Apple library id vs catalog id). */
export interface DestTrack {
  readonly canonical: CanonicalTrack;
  readonly destId: string;
}

/** A music platform the transfer engine can read from and additively write to.
 * Direction-agnostic: any provider can be a source or a destination. */
export interface MusicProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  // ── read (source side) ──────────────────────────────────────────────
  /** Read the full source set for a target (playlist or liked/favorites),
   * already mapped to canonical tracks. */
  readSourceTracks(ctx: UserCtx, target: ResolvedTarget): Promise<CanonicalTrack[]>;
  /** Read the destination's current set for idempotency, with each track's
   * write-id. Returns [] for a `create` target, and for a not-readable liked
   * set (`likedReadable: false`) — empty-D is additive-safe (favoriting /
   * adding is idempotent, and the §12.5 resume union dedupes re-runs). */
  readDestinationTracks(ctx: UserCtx, target: ResolvedTarget): Promise<DestTrack[]>;

  // ── match (destination side) ────────────────────────────────────────
  /** Tier-1 ISRC lookup. Returns [] when `!capabilities.supportsIsrc`. */
  searchByIsrc(ctx: UserCtx, isrcs: readonly string[]): Promise<CanonicalTrack[]>;
  /** Tier-2 scored-search candidate pool for a free-text term. */
  searchByTerm(ctx: UserCtx, term: string, limit: number): Promise<CanonicalTrack[]>;

  // ── write (additive only) ───────────────────────────────────────────
  /** Create a new playlist by name; returns its id. */
  createPlaylistNamed(ctx: UserCtx, name: string): Promise<string>;
  /** Additively write destination write-ids to the target (playlist append or
   * like/favorite). Never removes or reorders. */
  writeTracks(
    ctx: UserCtx,
    target: ResolvedTarget,
    playlistId: string | undefined,
    destIds: readonly string[],
  ): Promise<void>;
}

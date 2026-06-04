// Tiered matcher per blueprint §7 + §13.
//
//   Tier 1 — ISRC exact.
//     Spotify→Apple: GET /v1/catalog/{sf}/songs?filter[isrc]=...
//     Apple→Spotify: GET /v1/search?q=isrc:CODE&type=track
//     Disambiguate (when multiple): album match → non-compilation → first
//     validated. Deterministic; same inputs always pick the same candidate.
//
//   Tier 2 — Scored search (when no ISRC or ISRC yields nothing valid).
//     Query "<title> <primary artist>", score per §7 rubric, accept if ≥70.
//
//   Tier 3 — Unmatched.
//     Caller (operation runner) emits an `unmatched` event with metadata
//     + best rejected candidate + score.
//
// All matches are cached in the ledger `tracks` table so re-runs of the
// same operation skip the live calls (§8).

import { searchByIsrc as appleSearchByIsrc, searchCatalog as appleSearchCatalog, type AppleCatalogSong } from "../clients/apple.js";
import { searchTracksByIsrc as spotifySearchByIsrc, searchTracks as spotifySearchTracks, type SpotifyTrack } from "../clients/spotify.js";
import { getCachedTrack, putCachedTrack } from "../ledger/tracksCache.js";
import { durationsClose, identityKey, normalize, normArtist, normIsrc, normTitle, type CanonicalTrack } from "./identity.js";
import { isAccepted, score, SCORE_ACCEPT_THRESHOLD, DURATION_TOLERANCE_MS, type ScoreBreakdown } from "./scoring.js";

// ── Client injection seam ──────────────────────────────────────────────
//
// The matcher's Tier-1 / Tier-2 paths call live Spotify/Apple search
// endpoints. To make those paths unit-testable WITHOUT live tokens, the
// client functions are held in a mutable object that defaults to the real
// implementations; tests swap in fakes via __setMatcherClients and reset
// with __resetMatcherClients.

export interface MatcherClients {
  appleSearchByIsrc: typeof appleSearchByIsrc;
  appleSearchCatalog: typeof appleSearchCatalog;
  spotifySearchByIsrc: typeof spotifySearchByIsrc;
  spotifySearchTracks: typeof spotifySearchTracks;
}

const DEFAULT_CLIENTS: MatcherClients = {
  appleSearchByIsrc,
  appleSearchCatalog,
  spotifySearchByIsrc,
  spotifySearchTracks,
};

let clients: MatcherClients = { ...DEFAULT_CLIENTS };

/** Test-only: override one or more client functions. */
export function __setMatcherClients(overrides: Partial<MatcherClients>): void {
  clients = { ...clients, ...overrides };
}

/** Test-only: restore the real client functions. */
export function __resetMatcherClients(): void {
  clients = { ...DEFAULT_CLIENTS };
}

/** Tier-2 candidate pool size. Apple allows larger pages; Spotify's
 * /v1/search caps `limit` at 10 (see clients/spotify.ts). The matcher asks
 * each side for its own max via these constants. */
const APPLE_SEARCH_LIMIT = 25;
const SPOTIFY_SEARCH_LIMIT = 10;

// ── Result types ───────────────────────────────────────────────────────

export type MatchTier = "isrc" | "search" | "unmatched";

export interface MatchedDestination {
  /** Spotify track id OR Apple catalog song id. */
  readonly id: string;
  /** ISRC of the matched destination, if known. */
  readonly isrc: string | undefined;
  /** Canonical form for downstream logging / event payloads. */
  readonly canonical: CanonicalTrack;
}

export interface MatchResult {
  readonly tier: MatchTier;
  readonly confidence: number;
  readonly destination: MatchedDestination | undefined;
  /** Best candidate we rejected — surfaced in Tier-3 events so the user
   * can see what the matcher considered. */
  readonly rejected: { canonical: CanonicalTrack; score: ScoreBreakdown } | undefined;
  /** True when the result came from the ledger cache (no live API call). */
  readonly fromCache: boolean;
}

// ── Spotify ↔ Canonical adapters ───────────────────────────────────────

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

export function appleCatalogToCanonical(t: AppleCatalogSong): CanonicalTrack {
  // contentRating is undefined when Apple doesn't classify the track. Map
  // that to `explicit: undefined` (unknown), NOT `false` — otherwise a
  // Spotify source with explicit=false would spuriously earn the +10
  // explicit-match bonus against an Apple candidate whose rating is simply
  // unknown.
  const explicit =
    t.attributes.contentRating === undefined ? undefined : t.attributes.contentRating === "explicit";
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

// ── Disambiguation (§7 Tier 1) ─────────────────────────────────────────

const COMPILATION_ALBUM_PATTERNS = [
  /greatest hits/i,
  /best of/i,
  /\bcollection\b/i,
  /\bcompilation\b/i,
  /\banthology\b/i,
  /\bessentials\b/i,
  /\bhits\b/i,
];

function isLikelyCompilation(albumName: string | undefined): boolean {
  if (!albumName) return false;
  return COMPILATION_ALBUM_PATTERNS.some((re) => re.test(albumName));
}

/** A candidate is "validated" per §7 Tier-1 when it is fully attributed:
 * non-empty title + primary artist + a positive duration. Candidates that
 * fail this (404 stubs, partial records that Apple/Spotify sometimes return
 * for an ISRC) are dropped before disambiguation rather than silently
 * picked as `data[0]` (blueprint §6.4: "never blindly take data[0]"). */
export function isValidatedCandidate(c: CanonicalTrack): boolean {
  return (
    c.title.trim().length > 0 &&
    c.primaryArtist.trim().length > 0 &&
    c.durationMs !== undefined &&
    c.durationMs > 0
  );
}

/** Deterministic pick from multiple ISRC candidates, per §7 Tier-1:
 *   0. drop non-validated candidates (non-404, fully-attributed);
 *   1. candidate whose album matches the source album (normalized);
 *   2. first non-compilation candidate;
 *   3. first validated candidate.
 * Returns undefined only when NO candidate validates — the caller then
 * falls through to Tier-2 scored search rather than returning a stub. */
export function disambiguateIsrcCandidates(
  source: CanonicalTrack,
  candidates: readonly CanonicalTrack[],
): CanonicalTrack | undefined {
  const valid = candidates.filter(isValidatedCandidate);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];

  // Album comparison uses `normalize` (NOT normTitle, which strips
  // "(feat. …)" — albums don't carry featured-artist suffixes and stripping
  // them would mangle albums like "Greatest Hits feat... " edge cases).
  const srcAlbum = normalize(source.album ?? "");
  if (srcAlbum) {
    const albumMatch = valid.find((c) => normalize(c.album ?? "") === srcAlbum);
    if (albumMatch) return albumMatch;
  }

  const nonComp = valid.find((c) => !isLikelyCompilation(c.album));
  if (nonComp) return nonComp;

  return valid[0];
}

// ── Tier-2 disambiguation ──────────────────────────────────────────────

/** Returns the highest-scoring candidate AND its breakdown.
 *
 * Ties are broken deterministically so re-runs of the same Operation always
 * pick the same candidate regardless of the order the platform returned them:
 * among equal top scores, prefer the lowest ISRC string, then the lowest id.
 * Without this, candidate-list order (which Spotify/Apple don't guarantee
 * stable) would decide the winner. */
function bestScored(
  source: CanonicalTrack,
  candidates: readonly CanonicalTrack[],
): { winner: CanonicalTrack; breakdown: ScoreBreakdown } | undefined {
  if (candidates.length === 0) return undefined;
  let best: { winner: CanonicalTrack; breakdown: ScoreBreakdown } | undefined;
  for (const c of candidates) {
    const breakdown = score(source, c);
    if (!best) {
      best = { winner: c, breakdown };
      continue;
    }
    if (breakdown.total > best.breakdown.total) {
      best = { winner: c, breakdown };
    } else if (breakdown.total === best.breakdown.total) {
      const cKey = `${c.isrc ?? ""} ${c.sourceId}`;
      const bKey = `${best.winner.isrc ?? ""} ${best.winner.sourceId}`;
      if (cKey < bKey) best = { winner: c, breakdown };
    }
  }
  return best;
}

// ── Ledger cache hit ───────────────────────────────────────────────────

/** sqlite returns SQL NULL as JS `null`; coerce to `undefined` so the
 * value matches the `string | undefined` field types (strict `===` checks
 * downstream would otherwise see `null`). */
function nn<T>(v: T | null | undefined): T | undefined {
  return v === null || v === undefined ? undefined : v;
}

function cacheHit(source: CanonicalTrack): MatchResult | undefined {
  const key = identityKey(source);
  const row = getCachedTrack(key);
  if (!row || row.match_tier === "unmatched") return undefined;

  // Fuzzy-key collision guard: two genuinely different recordings can share
  // a `fuzzy:<title>|<artist>|<bucket>` key (no ISRC, near-equal duration).
  // For fuzzy keys we re-verify the stored identity fields against the live
  // source before trusting the cached destination — a mismatch means a
  // collision, so we treat it as a cache miss and re-resolve. ISRC keys are
  // globally unique by construction and need no such check.
  if (key.startsWith("fuzzy:")) {
    const titleOk = nn(row.norm_title) === normTitle(source.title);
    const artistOk = nn(row.norm_artist) === normArtist(source.primaryArtist);
    const durOk = durationsClose(nn(row.duration_ms), source.durationMs, DURATION_TOLERANCE_MS);
    if (!titleOk || !artistOk || !durOk) return undefined;
  }

  // Need destination-side id — depends on the direction of the operation.
  const destId = source.source === "spotify" ? nn(row.apple_catalog_id) : nn(row.spotify_id);
  if (!destId) return undefined;

  // NOTE: `canonical` on a cache hit carries the NORMALIZED identity fields
  // (lowercased, punctuation-stripped) — not display strings — because the
  // §9 `tracks` schema stores norm_title/norm_artist, not the destination's
  // raw display metadata. For an ISRC match source and destination are the
  // same recording so these are accurate; for a Tier-2 match they are the
  // source's normalized identity. Phase 7's runner uses `destination.id` to
  // write and reads display metadata from the destination set `D` it already
  // fetched — it must NOT rely on these fields for display.
  return {
    tier: row.match_tier,
    confidence: row.confidence,
    destination: {
      id: destId,
      isrc: nn(row.isrc),
      canonical: {
        isrc: nn(row.isrc),
        title: nn(row.norm_title) ?? "",
        primaryArtist: nn(row.norm_artist) ?? "",
        artists: nn(row.norm_artist) ? [row.norm_artist as string] : [],
        album: undefined,
        durationMs: nn(row.duration_ms),
        explicit: undefined,
        source: source.source === "spotify" ? "apple" : "spotify",
        sourceId: destId,
      },
    },
    fromCache: true,
    rejected: undefined,
  };
}

/** Persist a RESOLVED mapping to the ledger cache. Unmatched results are
 * intentionally NOT persisted: per blueprint §12.5 (self-healing), an
 * unmatched track must be retried on the next run because catalogs drift
 * and a track that misses today may match tomorrow. Caching an unmatched
 * result would suppress that retry. The unmatched event (with the rejected
 * candidate + score) is still emitted live by the operation runner and
 * recorded in `operation_events`. */
function persist(source: CanonicalTrack, result: MatchResult): void {
  if (result.tier === "unmatched" || !result.destination) return;
  putCachedTrack({
    identity_key: identityKey(source),
    isrc: result.destination.isrc ?? source.isrc,
    norm_title: normTitle(source.title),
    norm_artist: normArtist(source.primaryArtist),
    duration_ms: source.durationMs,
    spotify_id: source.source === "spotify" ? source.sourceId : result.destination.id,
    apple_catalog_id: source.source === "apple" ? source.sourceId : result.destination.id,
    apple_library_id: undefined, // populated by Phase 7 when a library write happens
    match_tier: result.tier,
    confidence: result.confidence,
    updated_at: new Date().toISOString(),
  });
}

// ── Public entrypoints ─────────────────────────────────────────────────

/** Match a Spotify track to its Apple-catalog counterpart. */
export async function matchSpotifyToApple(
  source: CanonicalTrack,
  opts?: { useCache?: boolean },
): Promise<MatchResult> {
  if (source.source !== "spotify") throw new Error("source must be a Spotify track");
  if (opts?.useCache !== false) {
    const hit = cacheHit(source);
    if (hit) return hit;
  }

  // Tier 1 — ISRC
  if (source.isrc) {
    const candidates = await clients.appleSearchByIsrc([source.isrc]);
    const canon = candidates.map(appleCatalogToCanonical);
    const pick = disambiguateIsrcCandidates(source, canon);
    if (pick) {
      const result: MatchResult = {
        tier: "isrc",
        confidence: 100,
        destination: { id: pick.sourceId, isrc: pick.isrc, canonical: pick },
        fromCache: false,
        rejected: undefined,
      };
      persist(source, result);
      return result;
    }
  }

  // Tier 2 — Scored search
  const term = `${source.title} ${source.primaryArtist}`.trim();
  if (term.length > 0) {
    const candidates = await clients.appleSearchCatalog(term, APPLE_SEARCH_LIMIT);
    const canon = candidates.map(appleCatalogToCanonical);
    const best = bestScored(source, canon);
    if (best && isAccepted(best.breakdown)) {
      const result: MatchResult = {
        tier: "search",
        confidence: best.breakdown.total,
        destination: { id: best.winner.sourceId, isrc: best.winner.isrc, canonical: best.winner },
        fromCache: false,
        rejected: undefined,
      };
      persist(source, result);
      return result;
    }
    // Tier 3 with a rejected candidate to surface
    if (best) {
      const result: MatchResult = {
        tier: "unmatched",
        confidence: best.breakdown.total,
        destination: undefined,
        rejected: { canonical: best.winner, score: best.breakdown },
        fromCache: false,
      };
      persist(source, result);
      return result;
    }
  }

  // Tier 3 — nothing returned
  const result: MatchResult = { tier: "unmatched", confidence: 0, destination: undefined, rejected: undefined, fromCache: false };
  persist(source, result);
  return result;
}

/** Match an Apple catalog track to its Spotify counterpart (symmetric). */
export async function matchAppleToSpotify(
  source: CanonicalTrack,
  opts?: { useCache?: boolean },
): Promise<MatchResult> {
  if (source.source !== "apple") throw new Error("source must be an Apple track");
  if (opts?.useCache !== false) {
    const hit = cacheHit(source);
    if (hit) return hit;
  }

  // Tier 1 — ISRC
  if (source.isrc) {
    const candidates = await clients.spotifySearchByIsrc(source.isrc);
    const canon = candidates.map(spotifyToCanonical);
    const pick = disambiguateIsrcCandidates(source, canon);
    if (pick) {
      const result: MatchResult = {
        tier: "isrc",
        confidence: 100,
        destination: { id: pick.sourceId, isrc: pick.isrc, canonical: pick },
        fromCache: false,
        rejected: undefined,
      };
      persist(source, result);
      return result;
    }
  }

  // Tier 2 — Scored search
  const term = `${source.title} ${source.primaryArtist}`.trim();
  if (term.length > 0) {
    const candidates = await clients.spotifySearchTracks(term, SPOTIFY_SEARCH_LIMIT);
    const canon = candidates.map(spotifyToCanonical);
    const best = bestScored(source, canon);
    if (best && isAccepted(best.breakdown)) {
      const result: MatchResult = {
        tier: "search",
        confidence: best.breakdown.total,
        destination: { id: best.winner.sourceId, isrc: best.winner.isrc, canonical: best.winner },
        fromCache: false,
        rejected: undefined,
      };
      persist(source, result);
      return result;
    }
    if (best) {
      const result: MatchResult = {
        tier: "unmatched",
        confidence: best.breakdown.total,
        destination: undefined,
        rejected: { canonical: best.winner, score: best.breakdown },
        fromCache: false,
      };
      persist(source, result);
      return result;
    }
  }

  const result: MatchResult = { tier: "unmatched", confidence: 0, destination: undefined, rejected: undefined, fromCache: false };
  persist(source, result);
  return result;
}

export { SCORE_ACCEPT_THRESHOLD };

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
import { identityKey, normArtist, normIsrc, normTitle, type CanonicalTrack } from "./identity.js";
import { isAccepted, score, SCORE_ACCEPT_THRESHOLD, type ScoreBreakdown } from "./scoring.js";

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
  return {
    isrc: normIsrc(t.attributes.isrc),
    title: t.attributes.name,
    primaryArtist: t.attributes.artistName,
    artists: [t.attributes.artistName],
    album: t.attributes.albumName,
    durationMs: t.attributes.durationInMillis,
    explicit: t.attributes.contentRating === "explicit",
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

/** Deterministic pick from multiple ISRC candidates:
 *   1. candidate whose album matches the source album (normalized);
 *   2. first non-compilation candidate;
 *   3. first validated candidate.
 * Always returns the first when the list isn't empty — never undefined. */
function disambiguateIsrcCandidates(
  source: CanonicalTrack,
  candidates: readonly CanonicalTrack[],
): CanonicalTrack | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const srcAlbum = normTitle(source.album ?? "");
  if (srcAlbum) {
    const albumMatch = candidates.find((c) => normTitle(c.album ?? "") === srcAlbum);
    if (albumMatch) return albumMatch;
  }

  const nonComp = candidates.find((c) => !isLikelyCompilation(c.album));
  if (nonComp) return nonComp;

  return candidates[0];
}

// ── Tier-2 disambiguation ──────────────────────────────────────────────

/** Returns the highest-scoring candidate AND its breakdown. */
function bestScored(
  source: CanonicalTrack,
  candidates: readonly CanonicalTrack[],
): { winner: CanonicalTrack; breakdown: ScoreBreakdown } | undefined {
  if (candidates.length === 0) return undefined;
  let best: { winner: CanonicalTrack; breakdown: ScoreBreakdown } | undefined;
  for (const c of candidates) {
    const breakdown = score(source, c);
    if (!best || breakdown.total > best.breakdown.total) best = { winner: c, breakdown };
  }
  return best;
}

// ── Ledger cache hit ───────────────────────────────────────────────────

function cacheHit(source: CanonicalTrack): MatchResult | undefined {
  const key = identityKey(source);
  const row = getCachedTrack(key);
  if (!row || row.match_tier === "unmatched") return undefined;

  // Need destination-side id — depends on the direction of the operation.
  const destId = source.source === "spotify" ? row.apple_catalog_id : row.spotify_id;
  if (!destId) return undefined;

  return {
    tier: row.match_tier,
    confidence: row.confidence,
    destination: {
      id: destId,
      isrc: row.isrc,
      canonical: {
        isrc: row.isrc,
        title: row.norm_title ?? "",
        primaryArtist: row.norm_artist ?? "",
        artists: row.norm_artist ? [row.norm_artist] : [],
        album: undefined,
        durationMs: row.duration_ms,
        explicit: undefined,
        source: source.source === "spotify" ? "apple" : "spotify",
        sourceId: destId,
      },
    },
    fromCache: true,
    rejected: undefined,
  };
}

function persist(source: CanonicalTrack, result: MatchResult): void {
  putCachedTrack({
    identity_key: identityKey(source),
    isrc: result.destination?.isrc ?? source.isrc,
    norm_title: normTitle(source.title),
    norm_artist: normArtist(source.primaryArtist),
    duration_ms: source.durationMs,
    spotify_id: source.source === "spotify" ? source.sourceId : result.destination?.id,
    apple_catalog_id: source.source === "apple" ? source.sourceId : result.destination?.id,
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
    const candidates = await appleSearchByIsrc([source.isrc]);
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
      // line marker
      persist(source, result);
      return result;
    }
  }

  // Tier 2 — Scored search
  const term = `${source.title} ${source.primaryArtist}`.trim();
  if (term.length > 0) {
    const candidates = await appleSearchCatalog(term, 25);
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
      // line marker
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
    const candidates = await spotifySearchByIsrc(source.isrc);
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
      // line marker
      persist(source, result);
      return result;
    }
  }

  // Tier 2 — Scored search
  const term = `${source.title} ${source.primaryArtist}`.trim();
  if (term.length > 0) {
    const candidates = await spotifySearchTracks(term, 25);
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
      // line marker
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

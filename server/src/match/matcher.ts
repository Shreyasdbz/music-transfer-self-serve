// Tiered matcher per blueprint §7 + §13, generalized to any destination
// provider (v2 / todo.md §B).
//
//   Tier 1 — ISRC exact (only when the destination provider exposes ISRC).
//     destProvider.searchByIsrc → disambiguate (album match → non-compilation →
//     first validated). Deterministic; same inputs always pick the same candidate.
//
//   Tier 2 — Scored search (no ISRC, ISRC yields nothing valid, or the
//     destination has no ISRC at all — e.g. YouTube). Query "<title> <primary
//     artist>", score per §7 rubric, accept if ≥70.
//
//   Tier 3 — Unmatched. The runner emits an `unmatched` event with metadata +
//     best rejected candidate + score.
//
// Direction-agnostic: ONE `matchToDestination(source, destProvider)` replaces
// the old per-direction functions. The provider returns already-canonical
// candidates (it owns its ⇆canonical adapter), so the matcher imports no
// clients. Resolved matches are cached in the ledger `tracks` table; the cache
// maps provider id → the v1 schema's spotify_id / apple_catalog_id columns
// (the generalized `track_provider_ids` table lands in phase V2).

import { getCachedTrack, putCachedTrack, type CachedTrack } from "../ledger/tracksCache.js";
import { durationsClose, identityKey, normalize, normArtist, normTitle, type CanonicalTrack } from "./identity.js";
import { isAccepted, score, SCORE_ACCEPT_THRESHOLD, DURATION_TOLERANCE_MS, type ScoreBreakdown } from "./scoring.js";
import { OWNER, type MusicProvider, type ProviderId } from "../providers/types.js";

// ── Result types ───────────────────────────────────────────────────────

export type MatchTier = "isrc" | "search" | "unmatched";

export interface MatchedDestination {
  /** Destination write-id (Spotify track id / Apple catalog song id / …). */
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
  /** Best candidate we rejected — surfaced in Tier-3 events. */
  readonly rejected: { canonical: CanonicalTrack; score: ScoreBreakdown } | undefined;
  /** True when the result came from the ledger cache (no live API call). */
  readonly fromCache: boolean;
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
 * non-empty title + primary artist + a positive duration. Drops 404 stubs /
 * partial records (blueprint §6.4: "never blindly take data[0]"). */
export function isValidatedCandidate(c: CanonicalTrack): boolean {
  return (
    c.title.trim().length > 0 &&
    c.primaryArtist.trim().length > 0 &&
    c.durationMs !== undefined &&
    c.durationMs > 0
  );
}

/** Deterministic pick from multiple ISRC candidates, per §7 Tier-1:
 *   0. drop non-validated candidates;
 *   1. candidate whose album matches the source album (normalized);
 *   2. first non-compilation candidate;
 *   3. first validated candidate.
 * Returns undefined only when NO candidate validates → caller falls to Tier-2. */
export function disambiguateIsrcCandidates(
  source: CanonicalTrack,
  candidates: readonly CanonicalTrack[],
): CanonicalTrack | undefined {
  const valid = candidates.filter(isValidatedCandidate);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];

  // Album comparison uses `normalize` (NOT normTitle, which strips "(feat. …)").
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

/** Highest-scoring candidate + its breakdown. Deterministic tie-break: among
 * equal top scores, prefer the lowest (isrc, id) so re-runs are stable. */
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
      const cKey = `${c.isrc ?? ""} ${c.sourceId}`;
      const bKey = `${best.winner.isrc ?? ""} ${best.winner.sourceId}`;
      if (cKey < bKey) best = { winner: c, breakdown };
    }
  }
  return best;
}

// ── Ledger cache (provider-keyed; v1 schema until V2 generalizes) ───────

/** sqlite NULL → JS null; coerce to undefined for `string | undefined` fields. */
function nn<T>(v: T | null | undefined): T | undefined {
  return v === null || v === undefined ? undefined : v;
}

/** The cached destination id for a provider, read from the v1 per-platform
 * columns. Returns undefined for providers without a column yet (e.g. YouTube),
 * which simply means "no cache hit" until V2's `track_provider_ids` lands. */
function providerColumnId(row: CachedTrack, providerId: ProviderId): string | undefined {
  if (providerId === "spotify") return nn(row.spotify_id);
  if (providerId === "apple") return nn(row.apple_catalog_id);
  return undefined;
}

/** The id to store in a given platform column when persisting a match: the
 * source id if the source IS that platform, else the destination id if the
 * destination is that platform, else undefined (COALESCE preserves existing). */
function columnIdFor(
  platform: ProviderId,
  source: CanonicalTrack,
  destProvider: MusicProvider,
  destId: string,
): string | undefined {
  if (source.source === platform) return source.sourceId;
  if (destProvider.id === platform) return destId;
  return undefined;
}

function cacheHit(source: CanonicalTrack, destProvider: MusicProvider): MatchResult | undefined {
  const key = identityKey(source);
  const row = getCachedTrack(key);
  if (!row || row.match_tier === "unmatched") return undefined;

  // Fuzzy-key collision guard: two different recordings can share a
  // `fuzzy:<title>|<artist>|<bucket>` key. Re-verify stored identity fields
  // against the live source before trusting the cached destination. ISRC keys
  // are globally unique and need no such check.
  if (key.startsWith("fuzzy:")) {
    const titleOk = nn(row.norm_title) === normTitle(source.title);
    const artistOk = nn(row.norm_artist) === normArtist(source.primaryArtist);
    const durOk = durationsClose(nn(row.duration_ms), source.durationMs, DURATION_TOLERANCE_MS);
    if (!titleOk || !artistOk || !durOk) return undefined;
  }

  const destId = providerColumnId(row, destProvider.id);
  if (!destId) return undefined;

  // `canonical` on a cache hit carries the NORMALIZED identity fields (the §9
  // `tracks` schema stores norm_title/norm_artist, not raw display metadata).
  // The runner uses `destination.id` to write and reads display metadata from
  // the destination set it already fetched — it must not rely on these fields.
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
        source: destProvider.id,
        sourceId: destId,
      },
    },
    fromCache: true,
    rejected: undefined,
  };
}

/** Persist a RESOLVED mapping. Unmatched results are intentionally NOT persisted
 * (§12.5: catalogs drift, so an unmatched track must be retried next run). */
function persist(source: CanonicalTrack, destProvider: MusicProvider, result: MatchResult): void {
  if (result.tier === "unmatched" || !result.destination) return;
  const destId = result.destination.id;
  putCachedTrack({
    identity_key: identityKey(source),
    isrc: result.destination.isrc ?? source.isrc,
    norm_title: normTitle(source.title),
    norm_artist: normArtist(source.primaryArtist),
    duration_ms: source.durationMs,
    spotify_id: columnIdFor("spotify", source, destProvider, destId),
    apple_catalog_id: columnIdFor("apple", source, destProvider, destId),
    apple_library_id: undefined, // populated when a library write happens
    match_tier: result.tier,
    confidence: result.confidence,
    updated_at: new Date().toISOString(),
  });
}

// ── Public entrypoint ──────────────────────────────────────────────────

/** Match a source track to its counterpart on `destProvider`. Direction-agnostic:
 * works for any (source provider, destination provider) pair. */
export async function matchToDestination(
  source: CanonicalTrack,
  destProvider: MusicProvider,
  opts?: { useCache?: boolean },
): Promise<MatchResult> {
  // Defensive guard (replaces the old per-direction `source !== "spotify"`
  // throws): a same-provider match is meaningless and would make the v1 cache
  // column mapping (columnIdFor) ambiguous — the source branch would win and
  // cache the source id as the destination write id. v1 routes already reject
  // source===destination; this surfaces any future regression loudly rather
  // than silently miscaching.
  if (source.source === destProvider.id) {
    throw new Error(`same_provider_match:${destProvider.id}`);
  }
  if (opts?.useCache !== false) {
    const hit = cacheHit(source, destProvider);
    if (hit) return hit;
  }

  // Tier 1 — ISRC (only when the destination exposes ISRC).
  if (source.isrc && destProvider.capabilities.supportsIsrc) {
    const candidates = await destProvider.searchByIsrc(OWNER, [source.isrc]);
    const pick = disambiguateIsrcCandidates(source, candidates);
    if (pick) {
      const result: MatchResult = {
        tier: "isrc",
        confidence: 100,
        destination: { id: pick.sourceId, isrc: pick.isrc, canonical: pick },
        fromCache: false,
        rejected: undefined,
      };
      persist(source, destProvider, result);
      return result;
    }
  }

  // Tier 2 — Scored search.
  const term = `${source.title} ${source.primaryArtist}`.trim();
  if (term.length > 0) {
    const candidates = await destProvider.searchByTerm(OWNER, term, destProvider.capabilities.searchLimit);
    const best = bestScored(source, candidates);
    if (best && isAccepted(best.breakdown)) {
      const result: MatchResult = {
        tier: "search",
        confidence: best.breakdown.total,
        destination: { id: best.winner.sourceId, isrc: best.winner.isrc, canonical: best.winner },
        fromCache: false,
        rejected: undefined,
      };
      persist(source, destProvider, result);
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
      persist(source, destProvider, result);
      return result;
    }
  }

  // Tier 3 — nothing returned.
  const result: MatchResult = { tier: "unmatched", confidence: 0, destination: undefined, rejected: undefined, fromCache: false };
  persist(source, destProvider, result);
  return result;
}

export { SCORE_ACCEPT_THRESHOLD };

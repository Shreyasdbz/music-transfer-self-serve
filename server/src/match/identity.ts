// Track-identity helpers per blueprint §7.
//
// A track has two possible identities:
//
//   - ISRC (International Standard Recording Code) — globally unique per
//     recording. Distinct recordings (remix / edit / live / remaster /
//     clean vs explicit) carry distinct ISRCs, so an ISRC match is the
//     gold standard for picking the *correct version* of a song.
//
//   - Fuzzy fallback — `<norm_title>|<norm_artist>|<durationBucket>` when
//     ISRC is missing or unmatched on the destination side. Lower-confidence;
//     the matcher flags these so the operation runner can mark them as
//     low-confidence in the ledger and the UI.
//
// Pure functions only. No I/O. No platform-specific logic — adapters live
// in `match/matcher.ts`.

/** Canonical form for matching: a track flattened across both platforms.
 *
 * Optional fields are declared `T | undefined` (not bare `T?`) so the
 * project's strict `exactOptionalPropertyTypes` accepts `undefined`
 * assignments — most upstream sources legitimately have missing fields
 * (no ISRC, no duration, no explicit flag), and forcing callers to
 * conditionally spread every assignment hurts readability without buying
 * any safety here. */
export interface CanonicalTrack {
  /** ISRC when present on the source. Already uppercased + trimmed. */
  readonly isrc: string | undefined;
  /** The primary title as the source sees it. */
  readonly title: string;
  /** Primary artist (first credit). Used both for query construction and
   * for the +30 primary-artist scoring rule. */
  readonly primaryArtist: string;
  /** All credited artists in display order. Used for richer fuzzy matching. */
  readonly artists: readonly string[];
  /** Album / collection name; may be empty for singles. */
  readonly album: string | undefined;
  /** Total duration in milliseconds; may be undefined if upstream omits. */
  readonly durationMs: number | undefined;
  /** Explicit content flag; undefined when the platform doesn't expose it. */
  readonly explicit: boolean | undefined;
  /** Source platform id (a `ProviderId`, e.g. "spotify" | "apple" | "youtube").
   * Typed `string` to avoid an import cycle with providers/types; the matcher
   * and cache key off it. */
  readonly source: string;
  /** Source-side identifier for the ledger cache. */
  readonly sourceId: string;
}

/** Title/album/artist tokens that signal a NON-master variant. Found in
 * a candidate but NOT the source → -25 per token (per §7). The list is
 * deliberately conservative; adding tokens here makes the matcher pickier
 * about treating remixes / live versions / instrumentals as equivalents. */
export const VARIANT_TOKENS = [
  "remix",
  "live",
  "sped up",
  "slowed",
  "remaster",
  "remastered",
  "instrumental",
  "edit",
  "karaoke",
  "cover",
  "acoustic",
  "demo",
] as const;

// ── Normalization ───────────────────────────────────────────────────────

/** Lowercase, strip diacritics, collapse punctuation/whitespace.
 * Used as the equality key for "normalized title exact match" (+40) and
 * "normalized album match" (+5) in scoring. */
export function normalize(s: string | undefined | null): string {
  if (!s) return "";
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics (U+0300–U+036F)
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ") // punctuation + symbols → space
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip common "feat. X" / "featuring X" / "(feat. X)" suffixes from a
 * title or artist string before normalization. Spotify and Apple disagree
 * about whether featured artists live in the title or the artist list. */
const FEAT_RE = /[([{][^)\]}]*\b(?:feat\.?|ft\.?|featuring)\b[^)\]}]*[)\]}]|[\s,-]+(?:feat\.?|ft\.?|featuring)\b.*$/i;

export function stripFeatured(s: string): string {
  return s.replace(FEAT_RE, "").trim();
}

/** Normalized title for matching. Strips "(feat. …)" suffixes that one side
 * usually has and the other doesn't. */
export function normTitle(title: string | undefined): string {
  return normalize(stripFeatured(title ?? ""));
}

/** Normalized primary artist for matching. */
export function normArtist(artist: string | undefined): string {
  return normalize(stripFeatured(artist ?? ""));
}

/** Multiset of normalized variant tokens present in `s`. Used by scoring to
 * compute the -25 penalty per token present in the candidate but not in
 * the source. */
export function variantTokens(s: string): readonly string[] {
  const n = " " + normalize(s) + " ";
  const found: string[] = [];
  for (const t of VARIANT_TOKENS) {
    if (n.includes(` ${t} `)) found.push(t);
  }
  return found;
}

// ── Identity key ────────────────────────────────────────────────────────

/** Round duration to the nearest 2-second bucket so two recordings whose
 * encoded durations differ by ±1s still collide. Tracks at the ±2s boundary
 * are intentionally rare; this is the fuzzy fallback, not gospel. */
function durationBucket(durationMs: number | undefined): string {
  if (durationMs === undefined || durationMs <= 0) return "?";
  return String(Math.round(durationMs / 2000));
}

/** Canonical ISRC form: uppercase, no whitespace, no dashes. */
export function normIsrc(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.toUpperCase().replace(/[\s-]/g, "");
  // ISRC = 2-letter country + 3-char registrant + 7-char year+designation
  // (total 12 chars). Reject malformed values rather than feeding them
  // upstream as a filter.
  if (!/^[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}$/.test(s)) return undefined;
  return s;
}

/** Primary identity key used by the ledger `tracks` table. ISRC when valid,
 * otherwise a fuzzy key for low-confidence cache hits. */
export function identityKey(track: CanonicalTrack): string {
  const isrc = normIsrc(track.isrc);
  if (isrc) return `isrc:${isrc}`;
  return `fuzzy:${normTitle(track.title)}|${normArtist(track.primaryArtist)}|${durationBucket(track.durationMs)}`;
}

/** True when `track.duration` and `candidate.duration` differ by less than
 * `tolerance_ms`. Both args may be undefined; missing-on-either-side fails. */
export function durationsClose(
  a: number | undefined,
  b: number | undefined,
  toleranceMs = 3000,
): boolean {
  if (a === undefined || b === undefined) return false;
  return Math.abs(a - b) <= toleranceMs;
}

// Tier-2 scored search per blueprint §7.
//
//   +40  normalized title exact match
//   +30  primary-artist overlap
//   +15  duration within ±3 s
//   +10  explicit flag matches
//   +5   normalized album match
//   -25  per unwanted variant token in candidate but NOT in source
//
//   accept threshold: 70
//
// The thresholds live here as exported constants so a future "Advanced" UI
// (blueprint §10) can override them via a `settings` table without code
// changes. Don't tune by editing the rubric — change the constants and
// document the new value in PROGRESS.md.

import {
  durationsClose,
  normalize,
  normArtist,
  normTitle,
  variantTokens,
  type CanonicalTrack,
} from "./identity.js";

export const SCORE_ACCEPT_THRESHOLD = 70;
export const DURATION_TOLERANCE_MS = 3000;

export const SCORE_TITLE = 40;
export const SCORE_PRIMARY_ARTIST = 30;
export const SCORE_DURATION = 15;
export const SCORE_EXPLICIT = 10;
export const SCORE_ALBUM = 5;
export const PENALTY_PER_VARIANT_TOKEN = 25;

export interface ScoreBreakdown {
  readonly total: number;
  readonly title: number;
  readonly primaryArtist: number;
  readonly duration: number;
  readonly explicit: number;
  readonly album: number;
  readonly variantPenalty: number;
  /** Variant tokens present in candidate but NOT in source. Surfaced for
   * the UI / event log so the user can see WHY a candidate scored low. */
  readonly variantTokensCandidate: readonly string[];
}

/** Score a candidate (destination side) against a source track. Deterministic
 * — same inputs always produce the same score so re-runs of the same Operation
 * disambiguate identically. */
export function score(source: CanonicalTrack, candidate: CanonicalTrack): ScoreBreakdown {
  const sTitle = normTitle(source.title);
  const cTitle = normTitle(candidate.title);
  const titlePoints = sTitle.length > 0 && sTitle === cTitle ? SCORE_TITLE : 0;

  const sArtist = normArtist(source.primaryArtist);
  const cArtists = candidate.artists.map((a) => normArtist(a));
  const cArtistJoined = normalize(candidate.artists.join(" "));
  // "overlap" — primary artist appears either as a credited artist on the
  // candidate or anywhere in the candidate's joined artist string (handles
  // "feat." that the platform put in the artist string).
  const artistPoints =
    sArtist.length > 0 &&
    (cArtists.includes(sArtist) || (sArtist.length >= 3 && cArtistJoined.includes(sArtist)))
      ? SCORE_PRIMARY_ARTIST
      : 0;

  const durationPoints = durationsClose(
    source.durationMs,
    candidate.durationMs,
    DURATION_TOLERANCE_MS,
  )
    ? SCORE_DURATION
    : 0;

  const explicitPoints =
    source.explicit !== undefined &&
    candidate.explicit !== undefined &&
    source.explicit === candidate.explicit
      ? SCORE_EXPLICIT
      : 0;

  const sAlbum = normalize(source.album ?? "");
  const cAlbum = normalize(candidate.album ?? "");
  const albumPoints = sAlbum.length > 0 && sAlbum === cAlbum ? SCORE_ALBUM : 0;

  // Variant penalty: a token present in the candidate's title/album AND not
  // in the source's same surfaces is a strong signal that the candidate is
  // a *different recording*. -25 per token, hard.
  const candidateTokens = [
    ...variantTokens(candidate.title),
    ...variantTokens(candidate.album ?? ""),
  ];
  const sourceTokens = new Set<string>([
    ...variantTokens(source.title),
    ...variantTokens(source.album ?? ""),
  ]);
  const unwanted = candidateTokens.filter((t) => !sourceTokens.has(t));
  // Deduplicate — a candidate titled "Remix (Remix)" shouldn't get hit twice.
  const unwantedUnique = Array.from(new Set(unwanted));
  const variantPenalty = unwantedUnique.length * PENALTY_PER_VARIANT_TOKEN;

  const total =
    titlePoints + artistPoints + durationPoints + explicitPoints + albumPoints - variantPenalty;

  return {
    total,
    title: titlePoints,
    primaryArtist: artistPoints,
    duration: durationPoints,
    explicit: explicitPoints,
    album: albumPoints,
    variantPenalty,
    variantTokensCandidate: unwantedUnique,
  };
}

/** True when the candidate's score clears the accept threshold. */
export function isAccepted(s: ScoreBreakdown): boolean {
  return s.total >= SCORE_ACCEPT_THRESHOLD;
}

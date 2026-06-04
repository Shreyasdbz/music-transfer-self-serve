// Phase 4 AC + unit coverage. No network — all matcher tests use the cache
// (pre-seeded) so we don't depend on live Spotify/Apple. The live AC #1
// verification (explicit ISRC pick) runs separately via an ephemeral script.

import { existsSync, copyFileSync, unlinkSync } from "node:fs";
import { LEDGER_PATH } from "../config.js";
import { closeLedger, openLedger } from "../ledger/db.js";
import { putCachedTrack } from "../ledger/tracksCache.js";
import {
  durationsClose,
  identityKey,
  normArtist,
  normIsrc,
  normTitle,
  normalize,
  stripFeatured,
  variantTokens,
  type CanonicalTrack,
} from "./identity.js";
import { isAccepted, score, SCORE_ACCEPT_THRESHOLD, PENALTY_PER_VARIANT_TOKEN } from "./scoring.js";
import { matchSpotifyToApple, spotifyToCanonical, appleCatalogToCanonical } from "./matcher.js";

// Snapshot/restore the real ledger.
const SNAPSHOT = LEDGER_PATH + ".match-test-snapshot";
const _hadLedger = existsSync(LEDGER_PATH);
if (_hadLedger) copyFileSync(LEDGER_PATH, SNAPSHOT);
process.on("exit", () => {
  try {
    closeLedger();
  } catch { /* ignore */ }
  if (_hadLedger) {
    copyFileSync(SNAPSHOT, LEDGER_PATH);
    try { unlinkSync(SNAPSHOT); } catch { /* ignore */ }
  } else if (existsSync(LEDGER_PATH)) {
    try { unlinkSync(LEDGER_PATH); } catch { /* ignore */ }
  }
});

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    process.stderr.write(`FAIL  ${msg}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS  ${msg}\n`);
  }
}

// ── identity.ts ─────────────────────────────────────────────────────────

assert(normalize("Don't  Stop, Believin'!") === "don t stop believin", `normalize: "Don't Stop, Believin'!"`);
assert(normalize("Café del Mar") === "cafe del mar", "normalize: strips diacritics");

assert(stripFeatured("Track (feat. Artist B)") === "Track", `stripFeatured: "(feat. X)"`);
assert(stripFeatured("Track [ft. X & Y]") === "Track", `stripFeatured: "[ft. X & Y]"`);
assert(stripFeatured("Senorita (feat. Maria)") === "Senorita", `stripFeatured: paren feat`);
assert(stripFeatured("Track Name") === "Track Name", "stripFeatured: no-op when no featuring");
assert(stripFeatured("Track Name, ft. Other") === "Track Name", "stripFeatured: comma feat");

assert(normTitle("Dust (feat. Drake)") === "dust", `normTitle: drops feat`);
assert(normTitle("Day 'N' Nite (Nightmare)") === "day n nite nightmare", "normTitle: punctuation collapse");

assert(normArtist("Drake & Future") === "drake future", "normArtist: ampersand collapse");

assert(normIsrc("us-ug1-26-04763") === "USUG12604763", "normIsrc: strips dashes + uppercases");
assert(normIsrc("USUG12604763") === "USUG12604763", "normIsrc: pass-through valid");
assert(normIsrc("not-an-isrc") === undefined, "normIsrc: rejects malformed");
assert(normIsrc(undefined) === undefined, "normIsrc: undefined → undefined");

assert(durationsClose(180_000, 182_000), "durationsClose: 2s diff within 3s tolerance");
assert(!durationsClose(180_000, 184_000), "durationsClose: 4s diff outside tolerance");
assert(!durationsClose(180_000, undefined), "durationsClose: undefined fails");

assert(variantTokens("Best Song (Remix)").includes("remix"), "variantTokens: catches Remix");
assert(variantTokens("Track (Live at Madison Square Garden)").includes("live"), "variantTokens: catches Live");
assert(variantTokens("Plain title").length === 0, "variantTokens: clean title returns []");

const isrcTrack: CanonicalTrack = { isrc: "USUG12604763", title: "x", primaryArtist: "y", artists: ["y"], album: undefined, durationMs: undefined, explicit: undefined, source: "spotify", sourceId: "1" };
assert(identityKey(isrcTrack) === "isrc:USUG12604763", "identityKey: ISRC form");

const noIsrcTrack: CanonicalTrack = { isrc: undefined, title: "Dust (feat. Drake)", primaryArtist: "Drake", artists: ["Drake"], album: undefined, durationMs: 180_000, explicit: undefined, source: "spotify", sourceId: "2" };
assert(identityKey(noIsrcTrack).startsWith("fuzzy:dust|drake|"), "identityKey: fuzzy form");

// ── scoring.ts ──────────────────────────────────────────────────────────

const explicit: CanonicalTrack = { isrc: undefined, title: "Lose Yourself", primaryArtist: "Eminem", artists: ["Eminem"], album: "8 Mile", durationMs: 320_000, explicit: true, source: "spotify", sourceId: "s1" };

const perfect = score(explicit, { ...explicit, source: "apple", sourceId: "a1" });
assert(perfect.total === 100, `score: identical match = 100 (got ${perfect.total})`);
assert(perfect.title === 40 && perfect.primaryArtist === 30 && perfect.duration === 15 && perfect.explicit === 10 && perfect.album === 5, "score: full breakdown");
assert(isAccepted(perfect), "isAccepted: 100 passes threshold");

const wrongArtist = score(explicit, { ...explicit, primaryArtist: "Someone Else", artists: ["Someone Else"], source: "apple", sourceId: "a2" });
assert(wrongArtist.total === 70 && wrongArtist.primaryArtist === 0, `score: wrong artist drops 30 (got ${wrongArtist.total})`);
assert(isAccepted(wrongArtist), "isAccepted: 70 exactly clears");

const wrongDuration = score(explicit, { ...explicit, durationMs: 600_000, source: "apple", sourceId: "a3" });
assert(wrongDuration.total === 85 && wrongDuration.duration === 0, `score: wrong duration drops 15 (got ${wrongDuration.total})`);

const remix = score(explicit, { ...explicit, title: "Lose Yourself (Remix)", source: "apple", sourceId: "a4" });
assert(remix.variantPenalty === PENALTY_PER_VARIANT_TOKEN, `score: remix triggers -25 penalty`);
assert(remix.variantTokensCandidate.includes("remix"), "score: remix token surfaced");
// Title now has "remix" so normalized title differs → title points 0
assert(remix.title === 0, `score: remix candidate title doesn't match source`);
// Total: 0 + 30 + 15 + 10 + 5 - 25 = 35 → below threshold
assert(!isAccepted(remix), "isAccepted: remix below threshold");

const explicitMismatch = score(explicit, { ...explicit, explicit: false, source: "apple", sourceId: "a5" });
assert(explicitMismatch.explicit === 0, "score: explicit-flag mismatch drops 10");

const noFeaturedDrift = score({ ...explicit, title: "Senorita" }, { isrc: undefined, title: "Senorita (feat. Camila)", primaryArtist: "Eminem", artists: ["Eminem"], album: explicit.album, durationMs: explicit.durationMs, explicit: explicit.explicit, source: "apple", sourceId: "a6" });
assert(noFeaturedDrift.title === 40, `score: (feat. ...) stripped before matching (got title=${noFeaturedDrift.title})`);

// SCORE_ACCEPT_THRESHOLD constant
assert(SCORE_ACCEPT_THRESHOLD === 70, `SCORE_ACCEPT_THRESHOLD = 70`);

// ── matcher.ts via the ledger cache ─────────────────────────────────────

// Open ledger so the cache table exists.
openLedger();

// Seed a Spotify→Apple cached row. matchSpotifyToApple should return the
// cached result without making any network calls (useCache defaults to true).
const cachedSource: CanonicalTrack = {
  isrc: "USUG99999999",
  title: "Cached Track",
  primaryArtist: "Cached Artist",
  artists: ["Cached Artist"],
  album: undefined,
  durationMs: 200_000,
  explicit: undefined,
  source: "spotify",
  sourceId: "spotify-cached-id",
};
putCachedTrack({
  identity_key: identityKey(cachedSource),
  isrc: cachedSource.isrc,
  norm_title: normTitle(cachedSource.title),
  norm_artist: normArtist(cachedSource.primaryArtist),
  duration_ms: cachedSource.durationMs,
  spotify_id: cachedSource.sourceId,
  apple_catalog_id: "apple-cached-id",
  apple_library_id: undefined,
  match_tier: "isrc",
  confidence: 100,
  updated_at: new Date().toISOString(),
});

const cacheResult = await matchSpotifyToApple(cachedSource);
assert(cacheResult.fromCache, "matcher: cache hit detected");
assert(cacheResult.tier === "isrc" && cacheResult.confidence === 100, "matcher: cache returns persisted tier+confidence");
assert(cacheResult.destination?.id === "apple-cached-id", `matcher: cache returns persisted apple id (got ${cacheResult.destination?.id})`);

// ── adapter coverage ─────────────────────────────────────────────────────

const spc = spotifyToCanonical({
  id: "s9",
  name: "T",
  artists: [{ id: "a1", name: "A" }, { id: "a2", name: "B" }],
  album: { id: "al1", name: "Alb" },
  duration_ms: 200_000,
  explicit: true,
  external_ids: { isrc: "us-ug1-26-04763" },
});
assert(spc.isrc === "USUG12604763", "spotifyToCanonical: normIsrc applied");
assert(spc.primaryArtist === "A" && spc.artists.length === 2, "spotifyToCanonical: primary + all artists");
assert(spc.explicit === true, "spotifyToCanonical: explicit propagated");

const apc = appleCatalogToCanonical({
  id: "a9",
  type: "songs",
  attributes: {
    name: "T",
    artistName: "A",
    albumName: "Alb",
    durationInMillis: 200_000,
    isrc: "USUG12604763",
    contentRating: "explicit",
  },
});
assert(apc.isrc === "USUG12604763" && apc.explicit === true, "appleCatalogToCanonical: ISRC + explicit");

process.exit(process.exitCode ?? 0);

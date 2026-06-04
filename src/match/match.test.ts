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
import {
  matchSpotifyToApple,
  matchAppleToSpotify,
  spotifyToCanonical,
  appleCatalogToCanonical,
  disambiguateIsrcCandidates,
  isValidatedCandidate,
  __setMatcherClients,
  __resetMatcherClients,
} from "./matcher.js";
import type { AppleCatalogSong } from "../clients/apple.js";
import type { SpotifyTrack } from "../clients/spotify.js";

// Snapshot/restore the real ledger — restore on exit AND on SIGINT so a
// Ctrl-C mid-run never leaves the user's ledger polluted with test rows.
const SNAPSHOT = LEDGER_PATH + ".match-test-snapshot";
const _hadLedger = existsSync(LEDGER_PATH);
if (_hadLedger) copyFileSync(LEDGER_PATH, SNAPSHOT);
function restoreLedger(): void {
  try {
    closeLedger();
  } catch { /* ignore */ }
  if (_hadLedger) {
    copyFileSync(SNAPSHOT, LEDGER_PATH);
    try { unlinkSync(SNAPSHOT); } catch { /* ignore */ }
  } else if (existsSync(LEDGER_PATH)) {
    try { unlinkSync(LEDGER_PATH); } catch { /* ignore */ }
  }
}
process.on("exit", restoreLedger);
process.on("SIGINT", () => {
  restoreLedger();
  process.exit(130);
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

// explicit undefined when contentRating absent (finding #9)
const apcNoRating = appleCatalogToCanonical({
  id: "a10",
  type: "songs",
  attributes: { name: "T", artistName: "A", albumName: "Alb", durationInMillis: 200_000, isrc: "USUG12604763" },
});
assert(apcNoRating.explicit === undefined, `appleCatalogToCanonical: no contentRating → explicit undefined (got ${apcNoRating.explicit})`);

// And the score consequence: a Spotify source with explicit=false vs an Apple
// candidate with unknown rating must NOT earn the +10 explicit bonus.
const expFalse: CanonicalTrack = { isrc: undefined, title: "T", primaryArtist: "A", artists: ["A"], album: "Alb", durationMs: 200_000, explicit: false, source: "spotify", sourceId: "s" };
const sc = score(expFalse, apcNoRating);
assert(sc.explicit === 0, `score: explicit=false vs unknown rating → 0 explicit points (got ${sc.explicit})`);

// ── isValidatedCandidate (§7 Tier-1) ────────────────────────────────────

const validC: CanonicalTrack = { isrc: "USUG12604763", title: "T", primaryArtist: "A", artists: ["A"], album: "Al", durationMs: 200_000, explicit: undefined, source: "apple", sourceId: "a" };
assert(isValidatedCandidate(validC), "isValidatedCandidate: full record passes");
assert(!isValidatedCandidate({ ...validC, title: "" }), "isValidatedCandidate: empty title fails");
assert(!isValidatedCandidate({ ...validC, primaryArtist: "  " }), "isValidatedCandidate: blank artist fails");
assert(!isValidatedCandidate({ ...validC, durationMs: 0 }), "isValidatedCandidate: zero duration fails");
assert(!isValidatedCandidate({ ...validC, durationMs: undefined }), "isValidatedCandidate: undefined duration fails");

// ── disambiguateIsrcCandidates (§7 Tier-1) ──────────────────────────────

function mk(id: string, over: Partial<CanonicalTrack> = {}): CanonicalTrack {
  return { isrc: "USUG12604763", title: "Song", primaryArtist: "Artist", artists: ["Artist"], album: "Studio Album", durationMs: 200_000, explicit: undefined, source: "apple", sourceId: id, ...over };
}
const srcWithAlbum = mk("src", { source: "spotify", album: "Deluxe Edition" });

// (a) album match wins
{
  const cands = [mk("c1", { album: "Some Other Album" }), mk("c2", { album: "Deluxe Edition" })];
  const pick = disambiguateIsrcCandidates(srcWithAlbum, cands);
  assert(pick?.sourceId === "c2", `disambiguate: source-album match wins (got ${pick?.sourceId})`);
}
// (b) no album match → first non-compilation
{
  const src = mk("src", { source: "spotify", album: "Nonexistent" });
  const cands = [mk("c1", { album: "Greatest Hits" }), mk("c2", { album: "Studio Album" })];
  const pick = disambiguateIsrcCandidates(src, cands);
  assert(pick?.sourceId === "c2", `disambiguate: non-compilation preferred over Greatest Hits (got ${pick?.sourceId})`);
}
// (c) all compilations → first (deterministic fallback)
{
  const src = mk("src", { source: "spotify", album: "Nonexistent" });
  const cands = [mk("c1", { album: "Greatest Hits" }), mk("c2", { album: "Best Of" })];
  const pick = disambiguateIsrcCandidates(src, cands);
  assert(pick?.sourceId === "c1", `disambiguate: all-compilation → first (got ${pick?.sourceId})`);
}
// (d) single candidate returned as-is
{
  const pick = disambiguateIsrcCandidates(srcWithAlbum, [mk("only")]);
  assert(pick?.sourceId === "only", "disambiguate: single candidate");
}
// (e) empty / all-invalid → undefined (caller falls to Tier-2)
{
  assert(disambiguateIsrcCandidates(srcWithAlbum, []) === undefined, "disambiguate: empty → undefined");
  const invalid = [mk("bad", { title: "", durationMs: 0 })];
  assert(disambiguateIsrcCandidates(srcWithAlbum, invalid) === undefined, "disambiguate: all-invalid → undefined");
}

// ── Matcher Tier-1 / Tier-2 via injected fake clients ───────────────────

// `over` is loosely typed so tests can set `isrc: undefined` without tripping
// exactOptionalPropertyTypes; the object is assembled then cast.
function fakeAppleSong(id: string, over: Record<string, unknown> = {}): AppleCatalogSong {
  const attributes = { name: "Real Song", artistName: "Real Artist", albumName: "Real Album", durationInMillis: 200_000, isrc: "USUG10000001", contentRating: "explicit", ...over };
  return { id, type: "songs", attributes } as AppleCatalogSong;
}
function fakeSpotifyTrack(id: string, over: Record<string, unknown> = {}): SpotifyTrack {
  return {
    id,
    name: "Real Song",
    artists: [{ id: "ra", name: "Real Artist" }],
    album: { id: "ral", name: "Real Album" },
    duration_ms: 200_000,
    explicit: true,
    external_ids: { isrc: "USUG10000001" },
    ...over,
  } as SpotifyTrack;
}

const liveSource: CanonicalTrack = { isrc: "USUG10000001", title: "Real Song", primaryArtist: "Real Artist", artists: ["Real Artist"], album: "Real Album", durationMs: 200_000, explicit: true, source: "spotify", sourceId: "live-sp-1" };

// Tier-1 happy path (Spotify→Apple) via fake
__setMatcherClients({
  appleSearchByIsrc: async () => [fakeAppleSong("apple-real-1")],
  appleSearchCatalog: async () => [],
});
{
  const r = await matchSpotifyToApple(liveSource, { useCache: false });
  assert(r.tier === "isrc" && r.destination?.id === "apple-real-1" && r.confidence === 100, `matcher Tier-1 (fake): isrc match → apple-real-1 (got tier=${r.tier} id=${r.destination?.id})`);
}

// Tier-1 returns only an invalid stub → falls through to Tier-2 scored search
__setMatcherClients({
  appleSearchByIsrc: async () => [fakeAppleSong("stub", { name: "", durationInMillis: 0 })],
  appleSearchCatalog: async () => [fakeAppleSong("apple-real-2")],
});
{
  const r = await matchSpotifyToApple(liveSource, { useCache: false });
  assert(r.tier === "search" && r.destination?.id === "apple-real-2", `matcher: invalid Tier-1 stub → Tier-2 (got tier=${r.tier} id=${r.destination?.id})`);
}

// Tier-2 below threshold → unmatched with rejected candidate surfaced
__setMatcherClients({
  appleSearchByIsrc: async () => [],
  appleSearchCatalog: async () => [fakeAppleSong("apple-wrong", { name: "Totally Different Title", artistName: "Other", isrc: undefined })],
});
{
  const noIsrcSource: CanonicalTrack = { ...liveSource, isrc: undefined, sourceId: "live-sp-2" };
  const r = await matchSpotifyToApple(noIsrcSource, { useCache: false });
  assert(r.tier === "unmatched", `matcher: low Tier-2 score → unmatched (got ${r.tier})`);
  assert(r.rejected?.canonical.sourceId === "apple-wrong", "matcher: unmatched surfaces rejected candidate");
  assert(r.destination === undefined, "matcher: unmatched has no destination");
}

// Symmetric Apple→Spotify Tier-1 via fake
const appleSource: CanonicalTrack = { isrc: "USUG10000001", title: "Real Song", primaryArtist: "Real Artist", artists: ["Real Artist"], album: "Real Album", durationMs: 200_000, explicit: true, source: "apple", sourceId: "live-ap-1" };
__setMatcherClients({
  spotifySearchByIsrc: async () => [fakeSpotifyTrack("spotify-real-1")],
  spotifySearchTracks: async () => [],
});
{
  const r = await matchAppleToSpotify(appleSource, { useCache: false });
  assert(r.tier === "isrc" && r.destination?.id === "spotify-real-1", `matcher symmetric Apple→Spotify Tier-1 (got tier=${r.tier} id=${r.destination?.id})`);
}

// Unmatched results are NOT persisted (finding #13) — re-run re-queries
let appleCallCount = 0;
__setMatcherClients({
  appleSearchByIsrc: async () => [],
  appleSearchCatalog: async () => { appleCallCount++; return []; },
});
{
  const noMatch: CanonicalTrack = { isrc: undefined, title: "Ghost Track XYZ", primaryArtist: "Nobody", artists: ["Nobody"], album: undefined, durationMs: 123_456, explicit: undefined, source: "spotify", sourceId: "ghost-1" };
  await matchSpotifyToApple(noMatch, { useCache: false });
  const r2 = await matchSpotifyToApple(noMatch); // cache allowed — but unmatched wasn't persisted
  assert(!r2.fromCache, "matcher: unmatched not cached — second call re-queries (not fromCache)");
  assert(appleCallCount === 2, `matcher: unmatched re-queried live both times (got ${appleCallCount} calls)`);
}

__resetMatcherClients();

// ── Fuzzy collision guard (finding #2) ──────────────────────────────────
// Seed a fuzzy-keyed row, then look up a DIFFERENT track that collides on the
// fuzzy key (same norm title+artist+bucket would be needed to collide; here we
// force a stored row whose norm fields DON'T match the new source → cacheHit
// must reject it).
{
  const collidingSource: CanonicalTrack = { isrc: undefined, title: "Intro", primaryArtist: "Band A", artists: ["Band A"], album: undefined, durationMs: 60_000, explicit: undefined, source: "spotify", sourceId: "intro-A" };
  const key = identityKey(collidingSource);
  // Seed a row at this key but with MISMATCHED norm fields (simulating a prior
  // collision where a different track grabbed the key).
  putCachedTrack({
    identity_key: key,
    isrc: undefined,
    norm_title: "different title",
    norm_artist: "different artist",
    duration_ms: 60_000,
    spotify_id: "intro-A",
    apple_catalog_id: "apple-WRONG",
    apple_library_id: undefined,
    match_tier: "search",
    confidence: 80,
    updated_at: new Date().toISOString(),
  });
  __setMatcherClients({ appleSearchByIsrc: async () => [], appleSearchCatalog: async () => [] });
  const r = await matchSpotifyToApple(collidingSource); // cache allowed
  assert(!r.fromCache, "fuzzy guard: mismatched norm fields → cache miss, not the wrong destination");
  __resetMatcherClients();
}

// ── bestScored deterministic tie-break — covered indirectly: two equal-
// scoring candidates pick the lexicographically-lower (isrc, id). We assert
// via the matcher with two identical-scoring fakes. ──────────────────────
__setMatcherClients({
  appleSearchByIsrc: async () => [],
  appleSearchCatalog: async () => [
    fakeAppleSong("zzz-id", { isrc: undefined }),
    fakeAppleSong("aaa-id", { isrc: undefined }),
  ],
});
{
  const src: CanonicalTrack = { isrc: undefined, title: "Real Song", primaryArtist: "Real Artist", artists: ["Real Artist"], album: "Real Album", durationMs: 200_000, explicit: true, source: "spotify", sourceId: "tie-1" };
  const r1 = await matchSpotifyToApple(src, { useCache: false });
  const r2 = await matchSpotifyToApple(src, { useCache: false });
  assert(r1.destination?.id === "aaa-id", `tie-break: lower id wins deterministically (got ${r1.destination?.id})`);
  assert(r1.destination?.id === r2.destination?.id, "tie-break: stable across runs");
}
__resetMatcherClients();

process.exit(process.exitCode ?? 0);

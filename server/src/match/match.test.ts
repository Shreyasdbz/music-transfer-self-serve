// Phase 4 AC + unit coverage, migrated to the v2 provider seam. No network —
// matcher tests inject FAKE PROVIDERS (returning canned canonical candidates)
// instead of the old fake client fns, and the cache tests pre-seed the ledger.
// The live AC #1 verification (explicit ISRC pick) runs separately.

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
import { matchToDestination, disambiguateIsrcCandidates, isValidatedCandidate } from "./matcher.js";
import { spotifyToCanonical } from "../providers/spotify/provider.js";
import { appleCatalogToCanonical } from "../providers/apple/provider.js";
import type { DestTrack, MusicProvider, ProviderCapabilities, UserCtx } from "../providers/types.js";
import type { ResolvedTarget } from "../operation/types.js";
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

// ── A fake destination provider returning canned canonical candidates ────
// The provider owns its ⇆canonical adapter, so its search methods return
// CanonicalTrack[] directly (tests build them via the real adapters below).

const FAKE_CAPS: ProviderCapabilities = {
  supportsIsrc: true,
  likedKind: "liked",
  likedReadable: true,
  supportsLikedRemoval: false,
  canCreatePlaylist: true,
  playlistAppendOnly: false,
  writeBatchAdd: 100,
  writeBatchLike: 40,
  searchLimit: 25,
};

interface FakeOpts {
  supportsIsrc?: boolean;
  searchLimit?: number;
  searchByIsrc?: () => Promise<CanonicalTrack[]>;
  searchByTerm?: () => Promise<CanonicalTrack[]>;
}

function fakeDest(id: string, opts: FakeOpts = {}): MusicProvider {
  const unused = (): never => {
    throw new Error(`unexpected_call:${id}`);
  };
  return {
    id,
    displayName: id,
    capabilities: {
      ...FAKE_CAPS,
      supportsIsrc: opts.supportsIsrc ?? true,
      searchLimit: opts.searchLimit ?? FAKE_CAPS.searchLimit,
    },
    searchByIsrc: async (_ctx: UserCtx, _isrcs: readonly string[]): Promise<CanonicalTrack[]> =>
      opts.searchByIsrc ? opts.searchByIsrc() : [],
    searchByTerm: async (_ctx: UserCtx, _term: string, _limit: number): Promise<CanonicalTrack[]> =>
      opts.searchByTerm ? opts.searchByTerm() : [],
    readSourceTracks: async (_c: UserCtx, _t: ResolvedTarget): Promise<CanonicalTrack[]> => unused(),
    readDestinationTracks: async (_c: UserCtx, _t: ResolvedTarget): Promise<DestTrack[]> => unused(),
    createPlaylistNamed: async (_c: UserCtx, _n: string): Promise<string> => unused(),
    writeTracks: async (): Promise<void> => unused(),
  };
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
assert(remix.title === 0, `score: remix candidate title doesn't match source`);
assert(!isAccepted(remix), "isAccepted: remix below threshold");

const explicitMismatch = score(explicit, { ...explicit, explicit: false, source: "apple", sourceId: "a5" });
assert(explicitMismatch.explicit === 0, "score: explicit-flag mismatch drops 10");

const noFeaturedDrift = score({ ...explicit, title: "Senorita" }, { isrc: undefined, title: "Senorita (feat. Camila)", primaryArtist: "Eminem", artists: ["Eminem"], album: explicit.album, durationMs: explicit.durationMs, explicit: explicit.explicit, source: "apple", sourceId: "a6" });
assert(noFeaturedDrift.title === 40, `score: (feat. ...) stripped before matching (got title=${noFeaturedDrift.title})`);

assert(SCORE_ACCEPT_THRESHOLD === 70, `SCORE_ACCEPT_THRESHOLD = 70`);

// ── matcher.ts via the ledger cache ─────────────────────────────────────

// Open ledger so the cache table exists.
openLedger();

// Seed a Spotify→Apple cached row. matchToDestination(source, apple) should
// return the cached result without any provider search call (useCache default).
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

// A fake apple destination whose search methods THROW — proving the cache hit
// short-circuits before any live call.
const appleDestNoSearch = fakeDest("apple", {
  searchByIsrc: async () => {
    throw new Error("cache_hit_should_not_search");
  },
  searchByTerm: async () => {
    throw new Error("cache_hit_should_not_search");
  },
});
const cacheResult = await matchToDestination(cachedSource, appleDestNoSearch);
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
assert(spc.source === "spotify", "spotifyToCanonical: source tagged spotify");

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
assert(apc.source === "apple", "appleCatalogToCanonical: source tagged apple");

// explicit undefined when contentRating absent
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

{
  const cands = [mk("c1", { album: "Some Other Album" }), mk("c2", { album: "Deluxe Edition" })];
  const pick = disambiguateIsrcCandidates(srcWithAlbum, cands);
  assert(pick?.sourceId === "c2", `disambiguate: source-album match wins (got ${pick?.sourceId})`);
}
{
  const src = mk("src", { source: "spotify", album: "Nonexistent" });
  const cands = [mk("c1", { album: "Greatest Hits" }), mk("c2", { album: "Studio Album" })];
  const pick = disambiguateIsrcCandidates(src, cands);
  assert(pick?.sourceId === "c2", `disambiguate: non-compilation preferred over Greatest Hits (got ${pick?.sourceId})`);
}
{
  const src = mk("src", { source: "spotify", album: "Nonexistent" });
  const cands = [mk("c1", { album: "Greatest Hits" }), mk("c2", { album: "Best Of" })];
  const pick = disambiguateIsrcCandidates(src, cands);
  assert(pick?.sourceId === "c1", `disambiguate: all-compilation → first (got ${pick?.sourceId})`);
}
{
  const pick = disambiguateIsrcCandidates(srcWithAlbum, [mk("only")]);
  assert(pick?.sourceId === "only", "disambiguate: single candidate");
}
{
  assert(disambiguateIsrcCandidates(srcWithAlbum, []) === undefined, "disambiguate: empty → undefined");
  const invalid = [mk("bad", { title: "", durationMs: 0 })];
  assert(disambiguateIsrcCandidates(srcWithAlbum, invalid) === undefined, "disambiguate: all-invalid → undefined");
}

// ── Matcher Tier-1 / Tier-2 via injected fake PROVIDERS ─────────────────

// Build canned candidates via the REAL adapters (the provider would do this).
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
const appleCand = (id: string, over: Record<string, unknown> = {}): CanonicalTrack => appleCatalogToCanonical(fakeAppleSong(id, over));
const spotifyCand = (id: string, over: Record<string, unknown> = {}): CanonicalTrack => spotifyToCanonical(fakeSpotifyTrack(id, over));

const liveSource: CanonicalTrack = { isrc: "USUG10000001", title: "Real Song", primaryArtist: "Real Artist", artists: ["Real Artist"], album: "Real Album", durationMs: 200_000, explicit: true, source: "spotify", sourceId: "live-sp-1" };

// Tier-1 happy path (Spotify→Apple)
{
  const dest = fakeDest("apple", { searchByIsrc: async () => [appleCand("apple-real-1")] });
  const r = await matchToDestination(liveSource, dest, { useCache: false });
  assert(r.tier === "isrc" && r.destination?.id === "apple-real-1" && r.confidence === 100, `matcher Tier-1 (fake): isrc match → apple-real-1 (got tier=${r.tier} id=${r.destination?.id})`);
}

// Tier-1 returns only an invalid stub → falls through to Tier-2 scored search
{
  const dest = fakeDest("apple", {
    searchByIsrc: async () => [appleCand("stub", { name: "", durationInMillis: 0 })],
    searchByTerm: async () => [appleCand("apple-real-2")],
  });
  const r = await matchToDestination(liveSource, dest, { useCache: false });
  assert(r.tier === "search" && r.destination?.id === "apple-real-2", `matcher: invalid Tier-1 stub → Tier-2 (got tier=${r.tier} id=${r.destination?.id})`);
}

// Tier-2 below threshold → unmatched with rejected candidate surfaced
{
  const dest = fakeDest("apple", { searchByTerm: async () => [appleCand("apple-wrong", { name: "Totally Different Title", artistName: "Other", isrc: undefined })] });
  const noIsrcSource: CanonicalTrack = { ...liveSource, isrc: undefined, sourceId: "live-sp-2" };
  const r = await matchToDestination(noIsrcSource, dest, { useCache: false });
  assert(r.tier === "unmatched", `matcher: low Tier-2 score → unmatched (got ${r.tier})`);
  assert(r.rejected?.canonical.sourceId === "apple-wrong", "matcher: unmatched surfaces rejected candidate");
  assert(r.destination === undefined, "matcher: unmatched has no destination");
}

// Symmetric Apple→Spotify Tier-1
{
  const appleSource: CanonicalTrack = { isrc: "USUG10000001", title: "Real Song", primaryArtist: "Real Artist", artists: ["Real Artist"], album: "Real Album", durationMs: 200_000, explicit: true, source: "apple", sourceId: "live-ap-1" };
  const dest = fakeDest("spotify", { searchByIsrc: async () => [spotifyCand("spotify-real-1")] });
  const r = await matchToDestination(appleSource, dest, { useCache: false });
  assert(r.tier === "isrc" && r.destination?.id === "spotify-real-1", `matcher symmetric Apple→Spotify Tier-1 (got tier=${r.tier} id=${r.destination?.id})`);
}

// AC: a destination with supportsIsrc:false (e.g. YouTube) skips Tier-1 entirely
// and matches via Tier-2 only — even when the source HAS an ISRC.
{
  let isrcCalled = false;
  const noIsrcDest = fakeDest("youtube", {
    supportsIsrc: false,
    searchByIsrc: async () => {
      isrcCalled = true;
      return [appleCand("should-not-be-used")];
    },
    searchByTerm: async () => [appleCand("yt-real")],
  });
  const r = await matchToDestination({ ...liveSource, sourceId: "yt-src-1" }, noIsrcDest, { useCache: false });
  assert(!isrcCalled, "Tier-2-only provider: searchByIsrc never called when supportsIsrc:false");
  assert(r.tier === "search" && r.destination?.id === "yt-real", `Tier-2-only provider: matched via scored search (got tier=${r.tier} id=${r.destination?.id})`);
}

// Unmatched results are NOT persisted — re-run re-queries
{
  let appleCallCount = 0;
  const dest = fakeDest("apple", { searchByTerm: async () => { appleCallCount++; return []; } });
  const noMatch: CanonicalTrack = { isrc: undefined, title: "Ghost Track XYZ", primaryArtist: "Nobody", artists: ["Nobody"], album: undefined, durationMs: 123_456, explicit: undefined, source: "spotify", sourceId: "ghost-1" };
  await matchToDestination(noMatch, dest, { useCache: false });
  const r2 = await matchToDestination(noMatch, dest); // cache allowed — but unmatched wasn't persisted
  assert(!r2.fromCache, "matcher: unmatched not cached — second call re-queries (not fromCache)");
  assert(appleCallCount === 2, `matcher: unmatched re-queried live both times (got ${appleCallCount} calls)`);
}

// ── Fuzzy collision guard ───────────────────────────────────────────────
// Seed a fuzzy-keyed row whose stored norm fields DON'T match a new source that
// collides on the fuzzy key → cacheHit must reject it (cache miss, not the
// wrong destination).
{
  const collidingSource: CanonicalTrack = { isrc: undefined, title: "Intro", primaryArtist: "Band A", artists: ["Band A"], album: undefined, durationMs: 60_000, explicit: undefined, source: "spotify", sourceId: "intro-A" };
  const key = identityKey(collidingSource);
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
  const dest = fakeDest("apple"); // empty searches → unmatched
  const r = await matchToDestination(collidingSource, dest); // cache allowed
  assert(!r.fromCache, "fuzzy guard: mismatched norm fields → cache miss, not the wrong destination");
}

// ── bestScored deterministic tie-break — two equal-scoring candidates pick
// the lexicographically-lower (isrc, id). ───────────────────────────────
{
  const dest = fakeDest("apple", {
    searchByTerm: async () => [appleCand("zzz-id", { isrc: undefined }), appleCand("aaa-id", { isrc: undefined })],
  });
  const src: CanonicalTrack = { isrc: undefined, title: "Real Song", primaryArtist: "Real Artist", artists: ["Real Artist"], album: "Real Album", durationMs: 200_000, explicit: true, source: "spotify", sourceId: "tie-1" };
  const r1 = await matchToDestination(src, dest, { useCache: false });
  const r2 = await matchToDestination(src, dest, { useCache: false });
  assert(r1.destination?.id === "aaa-id", `tie-break: lower id wins deterministically (got ${r1.destination?.id})`);
  assert(r1.destination?.id === r2.destination?.id, "tie-break: stable across runs");
}

process.exit(process.exitCode ?? 0);

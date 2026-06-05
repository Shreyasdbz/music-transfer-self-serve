// Provider coverage (added in V1 validation): the real spotify/apple provider
// wrapper objects + the Apple library adapter, none of which the matcher/runner
// tests exercise (they use fakes). Covers the network-free dispatch branches
// (target-kind routing, the additive-safety guards, capability invariants) and
// the appleLibraryToCanonical ISRC extraction. Branches that call the live
// clients (favorites→favoriteSongs, playlist→addTracks) are out of scope here.

import { spotifyProvider } from "./spotify/provider.js";
import { appleProvider, appleLibraryToCanonical } from "./apple/provider.js";
import { OWNER } from "./types.js";
import type { AppleLibrarySong } from "../clients/apple.js";

function assert(c: unknown, m: string): void {
  if (!c) {
    process.stderr.write(`FAIL  ${m}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS  ${m}\n`);
}

// ── capability invariants (additive-only encoded in the type + values) ───
assert(spotifyProvider.capabilities.supportsLikedRemoval === false, "spotify: supportsLikedRemoval is false (additive-only)");
assert(appleProvider.capabilities.supportsLikedRemoval === false, "apple: supportsLikedRemoval is false (additive-only)");
assert(spotifyProvider.capabilities.likedReadable === true, "spotify: liked set is readable");
assert(appleProvider.capabilities.likedReadable === false, "apple: favorites NOT readable (→ empty-D idempotency)");
assert(appleProvider.capabilities.playlistAppendOnly === true, "apple: playlists are append-only");
assert(spotifyProvider.id === "spotify" && appleProvider.id === "apple", "provider ids");

// ── readDestinationTracks: network-free branches return [] ───────────────
assert((await spotifyProvider.readDestinationTracks(OWNER, { kind: "create", name: "x" })).length === 0, "spotify readDest: create → []");
assert((await appleProvider.readDestinationTracks(OWNER, { kind: "create", name: "x" })).length === 0, "apple readDest: create → []");
assert((await appleProvider.readDestinationTracks(OWNER, { kind: "favorites" })).length === 0, "apple readDest: favorites → [] (not readable, additive-safe)");

// ── writeTracks: empty destIds is a no-op (no throw, no network) ──────────
await spotifyProvider.writeTracks(OWNER, { kind: "liked" }, undefined, []);
await appleProvider.writeTracks(OWNER, { kind: "favorites" }, undefined, []);
assert(true, "writeTracks: empty destIds → no-op (no throw)");

// ── writeTracks: a playlist write with no playlist id throws (never write to
// a null/unknown target — additive-safety) ───────────────────────────────
async function throwsMissingPlaylist(fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return (e as Error).message === "missing_destination_playlist_id";
  }
}
assert(await throwsMissingPlaylist(() => spotifyProvider.writeTracks(OWNER, { kind: "playlist", id: "x" }, undefined, ["a"])), "spotify writeTracks: playlist target w/o playlistId throws");
assert(await throwsMissingPlaylist(() => appleProvider.writeTracks(OWNER, { kind: "playlist", id: "x" }, undefined, ["a"])), "apple writeTracks: playlist target w/o playlistId throws");

// ── readSourceTracks: invalid target kind throws (network-free) ──────────
async function throwsInvalidSource(fn: () => Promise<unknown>, msg: string): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return (e as Error).message === msg;
  }
}
assert(await throwsInvalidSource(() => spotifyProvider.readSourceTracks(OWNER, { kind: "favorites" }), "invalid_spotify_source_target"), "spotify readSource: favorites kind → invalid target throw");
assert(await throwsInvalidSource(() => appleProvider.readSourceTracks(OWNER, { kind: "liked" }), "invalid_apple_source_target"), "apple readSource: liked kind → invalid target throw");

// ── appleLibraryToCanonical: ISRC extraction from the catalog relationship ─
const libWithCatalog: AppleLibrarySong = {
  id: "lib-1",
  type: "library-songs",
  attributes: { name: "Song", artistName: "Artist", albumName: "Album", durationInMillis: 200_000, contentRating: "explicit" },
  relationships: { catalog: { data: [{ id: "cat-1", type: "songs", attributes: { isrc: "USUG12604763" } }] } },
};
{
  const c = appleLibraryToCanonical(libWithCatalog);
  assert(c.isrc === "USUG12604763", "appleLibraryToCanonical: ISRC from embedded catalog relationship");
  assert(c.title === "Song" && c.primaryArtist === "Artist" && c.sourceId === "lib-1", "appleLibraryToCanonical: title/artist/sourceId");
  assert(c.source === "apple", "appleLibraryToCanonical: source tagged apple");
  assert(c.explicit === true, "appleLibraryToCanonical: explicit from contentRating");
}
{
  // No catalog relationship and no attributes.isrc → undefined (drops to Tier-2).
  const libNoIsrc: AppleLibrarySong = { id: "lib-2", type: "library-songs", attributes: { name: "S", artistName: "A" } };
  assert(appleLibraryToCanonical(libNoIsrc).isrc === undefined, "appleLibraryToCanonical: no catalog + no attr isrc → undefined");
  assert(appleLibraryToCanonical(libNoIsrc).explicit === undefined, "appleLibraryToCanonical: no contentRating → explicit undefined");
}
{
  // Falls back to attributes.isrc when the catalog relationship is absent.
  const libAttrIsrc: AppleLibrarySong = { id: "lib-3", type: "library-songs", attributes: { name: "S", artistName: "A", isrc: "us-ug1-26-04763" } };
  assert(appleLibraryToCanonical(libAttrIsrc).isrc === "USUG12604763", "appleLibraryToCanonical: falls back to (normalized) attributes.isrc");
}

process.exit(process.exitCode ?? 0);

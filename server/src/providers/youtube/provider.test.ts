// YouTube placeholder provider: it must appear (registered, named) but be
// non-functional — available:false, no-ISRC capabilities, and every read/write
// method rejects so it can never be used in a transfer. Pure, no network.

import { youtubeProvider } from "./provider.js";
import { OWNER } from "../types.js";

function assert(c: unknown, m: string): void {
  if (!c) {
    process.stderr.write(`FAIL  ${m}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS  ${m}\n`);
}

// Identity + placeholder status.
assert(youtubeProvider.id === "youtube", "id is youtube");
assert(youtubeProvider.displayName === "YouTube Music", "displayName is YouTube Music");
assert(youtubeProvider.available === false, "available is false (placeholder)");

// Honest forward-looking capabilities (no ISRC → Tier-2 only; additive-only).
const cap = youtubeProvider.capabilities;
assert(cap.supportsIsrc === false, "supportsIsrc false (no ISRC)");
assert(cap.supportsLikedRemoval === false, "supportsLikedRemoval false (additive-only invariant)");
assert(cap.likedReadable === false, "likedReadable false");
assert(cap.playlistAppendOnly === true, "playlistAppendOnly true");

// Every method rejects with the provider_unavailable signal.
async function rejects(p: Promise<unknown>, label: string): Promise<void> {
  try {
    await p;
    assert(false, `${label} should reject`);
  } catch (e) {
    assert(
      (e as Error).message.startsWith("provider_unavailable:youtube"),
      `${label} rejects provider_unavailable`,
    );
  }
}

const t = { kind: "playlist", id: "x" } as const;
await rejects(youtubeProvider.readSourceTracks(OWNER, t), "readSourceTracks");
await rejects(youtubeProvider.readDestinationTracks(OWNER, t), "readDestinationTracks");
await rejects(youtubeProvider.searchByIsrc(OWNER, ["USABC1234567"]), "searchByIsrc");
await rejects(youtubeProvider.searchByTerm(OWNER, "x", 5), "searchByTerm");
await rejects(youtubeProvider.createPlaylistNamed(OWNER, "x"), "createPlaylistNamed");
await rejects(youtubeProvider.writeTracks(OWNER, t, undefined, ["v"]), "writeTracks");

process.stdout.write("youtube/provider.test.ts done\n");

// Registry unit tests: register / get / has / list, duplicate + unknown errors,
// and that capabilities carry through. No DB, no network — pure in-memory.

import { registerProvider, getProvider, hasProvider, listProviders, __clearRegistry } from "./registry.js";
import type { MusicProvider, ProviderCapabilities } from "./types.js";

function assert(c: unknown, m: string): void {
  if (!c) {
    process.stderr.write(`FAIL  ${m}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS  ${m}\n`);
}

const caps: ProviderCapabilities = {
  supportsIsrc: true,
  likedKind: "liked",
  likedReadable: true,
  supportsLikedRemoval: false,
  canCreatePlaylist: true,
  playlistAppendOnly: false,
  writeBatchAdd: 100,
  writeBatchLike: 40,
  searchLimit: 10,
};

/** Minimal fake provider; the operation/match methods reject so a stray call
 * surfaces in a test rather than silently passing. */
function fake(id: string, displayName: string, overrides: Partial<ProviderCapabilities> = {}): MusicProvider {
  const unused = (): never => {
    throw new Error(`unexpected_call:${id}`);
  };
  return {
    id,
    displayName,
    capabilities: { ...caps, ...overrides },
    readSourceTracks: unused,
    readDestinationTracks: unused,
    searchByIsrc: unused,
    searchByTerm: unused,
    createPlaylistNamed: unused,
    writeTracks: unused,
  };
}

__clearRegistry();

// ── register / get / has ───────────────────────────────────────────────
const spotify = fake("spotify", "Spotify");
const apple = fake("apple", "Apple Music", { likedKind: "favorites", likedReadable: false, playlistAppendOnly: true });
registerProvider(spotify);
registerProvider(apple);

assert(getProvider("spotify") === spotify, "getProvider returns the registered instance");
assert(getProvider("apple").displayName === "Apple Music", "getProvider resolves by id");
assert(hasProvider("spotify") && hasProvider("apple"), "hasProvider true for registered");
assert(!hasProvider("youtube"), "hasProvider false for unregistered");

// ── capabilities carry through ─────────────────────────────────────────
assert(getProvider("apple").capabilities.likedReadable === false, "apple capability: likedReadable false");
assert(getProvider("apple").capabilities.playlistAppendOnly === true, "apple capability: append-only");
assert(getProvider("apple").capabilities.supportsLikedRemoval === false, "additive-only: supportsLikedRemoval is false");

// ── list preserves registration order ──────────────────────────────────
const ids = listProviders().map((p) => p.id);
assert(ids.length === 2 && ids[0] === "spotify" && ids[1] === "apple", `listProviders order (got ${ids.join(",")})`);

// ── errors ─────────────────────────────────────────────────────────────
let threwDup = false;
try {
  registerProvider(fake("spotify", "dup"));
} catch (e) {
  threwDup = (e as Error).message === "provider_already_registered:spotify";
}
assert(threwDup, "registerProvider throws on duplicate id");

let threwUnknown = false;
try {
  getProvider("youtube");
} catch (e) {
  threwUnknown = (e as Error).message === "unknown_provider:youtube";
}
assert(threwUnknown, "getProvider throws unknown_provider for unregistered id");

__clearRegistry();
assert(listProviders().length === 0, "__clearRegistry empties the registry");

process.exit(process.exitCode ?? 0);

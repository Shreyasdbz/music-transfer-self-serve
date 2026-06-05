// Locks the built-in registration contract: registerBuiltInProviders() puts
// spotify + apple (functional) and youtube (placeholder) in the registry with
// the right ids + capabilities. Pure, no network. (registry.test.ts uses fakes
// and clears the registry; this exercises the REAL provider objects.)

import { registerBuiltInProviders } from "./index.js";
import { listProviders, getProvider, hasProvider } from "./registry.js";

function assert(c: unknown, m: string): void {
  if (!c) {
    process.stderr.write(`FAIL  ${m}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS  ${m}\n`);
}

registerBuiltInProviders();
// Idempotent: a second call must not throw (server + scripts both call it).
registerBuiltInProviders();

assert(hasProvider("spotify") && hasProvider("apple"), "spotify + apple registered");

const spotify = getProvider("spotify");
assert(spotify.displayName === "Spotify", "spotify displayName");
assert(spotify.available !== false, "spotify is available");
assert(spotify.capabilities.supportsIsrc === true, "spotify supportsIsrc");
assert(spotify.capabilities.likedKind === "liked", "spotify likedKind=liked");
assert(spotify.capabilities.likedReadable === true, "spotify likedReadable");

const apple = getProvider("apple");
assert(apple.displayName === "Apple Music", "apple displayName");
assert(apple.available !== false, "apple is available");
assert(apple.capabilities.supportsIsrc === true, "apple supportsIsrc");
assert(apple.capabilities.likedKind === "favorites", "apple likedKind=favorites");
assert(apple.capabilities.likedReadable === false, "apple favorites NOT readable");
assert(apple.capabilities.playlistAppendOnly === true, "apple playlists append-only");

// Additive-only invariant is encoded in the type, assert it holds at runtime too.
for (const p of listProviders()) {
  assert(
    p.capabilities.supportsLikedRemoval === false,
    `${p.id}: supportsLikedRemoval is false (additive-only)`,
  );
}

process.stdout.write("builtin.test.ts done\n");

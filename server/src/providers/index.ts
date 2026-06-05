// Built-in provider registration. Called once at server startup so the engine
// can resolve providers by id. YouTube registers as a non-functional
// placeholder (available: false) — it appears in the UI but is deferred to a
// future iteration; flip its `available` + implement the methods to enable it.

import { hasProvider, registerProvider } from "./registry.js";
import { spotifyProvider } from "./spotify/provider.js";
import { appleProvider } from "./apple/provider.js";
import { youtubeProvider } from "./youtube/provider.js";

/** Register the built-in providers. Idempotent — safe to call from multiple
 * entrypoints (server, future scripts) without throwing on the second call. */
export function registerBuiltInProviders(): void {
  if (!hasProvider(spotifyProvider.id)) registerProvider(spotifyProvider);
  if (!hasProvider(appleProvider.id)) registerProvider(appleProvider);
  if (!hasProvider(youtubeProvider.id)) registerProvider(youtubeProvider);
}

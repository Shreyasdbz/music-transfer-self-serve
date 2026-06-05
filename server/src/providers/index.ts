// Built-in provider registration. Called once at server startup so the engine
// can resolve providers by id. YouTube (phase V7) registers here too once it
// exists — no other wiring changes.

import { hasProvider, registerProvider } from "./registry.js";
import { spotifyProvider } from "./spotify/provider.js";
import { appleProvider } from "./apple/provider.js";

/** Register the built-in providers. Idempotent — safe to call from multiple
 * entrypoints (server, future scripts) without throwing on the second call. */
export function registerBuiltInProviders(): void {
  if (!hasProvider(spotifyProvider.id)) registerProvider(spotifyProvider);
  if (!hasProvider(appleProvider.id)) registerProvider(appleProvider);
}

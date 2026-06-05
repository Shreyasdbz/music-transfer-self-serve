// Provider registry. Replaces the hardcoded `=== "spotify"` / `=== "apple"`
// dispatch across deps, matcher, catalog, preflight, and routes with a single
// lookup keyed on ProviderId. Providers register themselves at startup
// (server/src/providers/index.ts); the engine resolves them by id.

import type { MusicProvider, ProviderId } from "./types.js";

const REGISTRY = new Map<ProviderId, MusicProvider>();

/** Register a provider. Throws on a duplicate id so a double-registration bug
 * is loud rather than silently shadowing. */
export function registerProvider(provider: MusicProvider): void {
  if (REGISTRY.has(provider.id)) {
    throw new Error(`provider_already_registered:${provider.id}`);
  }
  REGISTRY.set(provider.id, provider);
}

/** Resolve a provider by id. Throws `unknown_provider:<id>` if absent — callers
 * treat an unknown provider as a hard error (a typo'd platform must never
 * silently no-op). */
export function getProvider(id: ProviderId): MusicProvider {
  const provider = REGISTRY.get(id);
  if (!provider) throw new Error(`unknown_provider:${id}`);
  return provider;
}

export function hasProvider(id: ProviderId): boolean {
  return REGISTRY.has(id);
}

/** All registered providers, in registration order. Drives the UI's provider
 * list and the catalog/preflight loops (so YouTube appears with no extra
 * wiring once its provider registers). */
export function listProviders(): MusicProvider[] {
  return [...REGISTRY.values()];
}

/** Test-only: reset the registry between unit tests. */
export function __clearRegistry(): void {
  REGISTRY.clear();
}

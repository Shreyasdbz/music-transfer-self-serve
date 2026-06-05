// The injectable client surface the Operation runner depends on. v2: the real
// implementations are thin lookups into the provider registry — all
// platform-specific read/match/write logic now lives inside each MusicProvider
// (server/src/providers/*), so this file no longer branches on "spotify" vs
// "apple". Tests still swap in fakes via __setOperationDeps so the runner's
// logic (skip / match / write / resume) is exercised with ZERO real API calls.

import type { CanonicalTrack } from "../match/identity.js";
import type { MatchResult } from "../match/matcher.js";
import { matchToDestination } from "../match/matcher.js";
import { identityKey } from "../match/identity.js";
import { deleteCachedTrack } from "../ledger/tracksCache.js";
import { getProvider } from "../providers/registry.js";
import { OWNER, type DestTrack } from "../providers/types.js";
import type { OperationSpec, Platform, ResolvedTarget } from "./types.js";

export type { DestTrack };

export interface OperationDeps {
  readSource(source: Platform, target: ResolvedTarget): Promise<CanonicalTrack[]>;
  readDestination(destination: Platform, target: ResolvedTarget): Promise<DestTrack[]>;
  createDestination(destination: Platform, name: string): Promise<string>; // new playlist id
  /** Resolve `source` against the `destination` provider (ledger cache → live
   * ISRC → scored search). `destination` is passed explicitly (v2): it can no
   * longer be inferred as "the opposite platform" once >2 providers exist. */
  match(source: CanonicalTrack, useCache: boolean, destination: Platform): Promise<MatchResult>;
  deleteCache(source: CanonicalTrack): void;
  writeTracks(
    destination: Platform,
    target: ResolvedTarget,
    playlistId: string | undefined,
    destIds: string[],
  ): Promise<void>;
}

// ── Real implementations (registry-backed) ───────────────────────────────

async function readSource(source: Platform, target: ResolvedTarget): Promise<CanonicalTrack[]> {
  return getProvider(source).readSourceTracks(OWNER, target);
}

async function readDestination(destination: Platform, target: ResolvedTarget): Promise<DestTrack[]> {
  return getProvider(destination).readDestinationTracks(OWNER, target);
}

async function createDestination(destination: Platform, name: string): Promise<string> {
  return getProvider(destination).createPlaylistNamed(OWNER, name);
}

async function match(source: CanonicalTrack, useCache: boolean, destination: Platform): Promise<MatchResult> {
  return matchToDestination(source, getProvider(destination), { useCache });
}

function deleteCache(source: CanonicalTrack): void {
  deleteCachedTrack(identityKey(source));
}

async function writeTracks(
  destination: Platform,
  target: ResolvedTarget,
  playlistId: string | undefined,
  destIds: string[],
): Promise<void> {
  return getProvider(destination).writeTracks(OWNER, target, playlistId, destIds);
}

const REAL_DEPS: OperationDeps = {
  readSource,
  readDestination,
  createDestination,
  match,
  deleteCache,
  writeTracks,
};

let deps: OperationDeps = REAL_DEPS;

export function getOperationDeps(): OperationDeps {
  return deps;
}

/** Test-only: override the dep surface. */
export function __setOperationDeps(overrides: Partial<OperationDeps>): void {
  deps = { ...REAL_DEPS, ...overrides };
}
export function __resetOperationDeps(): void {
  deps = REAL_DEPS;
}

export type { OperationSpec };

// deps.ts coverage (added in V1 validation): locks the registry-backed routing
// that the provider refactor introduced. The old deps inferred the destination
// as "the opposite platform"; the new deps forwards an explicit `destination`
// and resolves every call through getProvider(). A recording fake provider
// proves each dep method routes to the right provider with the right args —
// especially that match() searches the DESTINATION provider, not the source.
// Network-free: the recording providers return empty search results so
// match() ends `unmatched` (persist is a no-op) and no ledger is touched.

import { registerProvider, __clearRegistry } from "../providers/registry.js";
import { getOperationDeps, __resetOperationDeps } from "./deps.js";
import { OWNER, type DestTrack, type MusicProvider, type ProviderCapabilities, type UserCtx } from "../providers/types.js";
import type { CanonicalTrack } from "../match/identity.js";
import type { ResolvedTarget } from "./types.js";

function assert(c: unknown, m: string): void {
  if (!c) {
    process.stderr.write(`FAIL  ${m}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS  ${m}\n`);
}

const CAPS: ProviderCapabilities = {
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

function recordingProvider(id: string): { p: MusicProvider; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string, args: unknown[]): void => {
    calls[name] = args;
  };
  const p: MusicProvider = {
    id,
    displayName: id,
    capabilities: CAPS,
    async readSourceTracks(ctx: UserCtx, t: ResolvedTarget): Promise<CanonicalTrack[]> {
      rec("readSourceTracks", [ctx, t]);
      return [];
    },
    async readDestinationTracks(ctx: UserCtx, t: ResolvedTarget): Promise<DestTrack[]> {
      rec("readDestinationTracks", [ctx, t]);
      return [];
    },
    async searchByIsrc(ctx: UserCtx, isrcs: readonly string[]): Promise<CanonicalTrack[]> {
      rec("searchByIsrc", [ctx, isrcs]);
      return [];
    },
    async searchByTerm(ctx: UserCtx, term: string, limit: number): Promise<CanonicalTrack[]> {
      rec("searchByTerm", [ctx, term, limit]);
      return [];
    },
    async createPlaylistNamed(ctx: UserCtx, name: string): Promise<string> {
      rec("createPlaylistNamed", [ctx, name]);
      return "new-playlist-id";
    },
    async writeTracks(ctx: UserCtx, t: ResolvedTarget, pl: string | undefined, ids: readonly string[]): Promise<void> {
      rec("writeTracks", [ctx, t, pl, ids]);
    },
  };
  return { p, calls };
}

__clearRegistry();
const src = recordingProvider("srcp");
const dst = recordingProvider("dstp");
registerProvider(src.p);
registerProvider(dst.p);

const deps = getOperationDeps(); // the REAL registry-backed deps (no override)
const target: ResolvedTarget = { kind: "playlist", id: "PL1" };
const source: CanonicalTrack = {
  isrc: "USUG10000001",
  title: "T",
  primaryArtist: "A",
  artists: ["A"],
  album: "Al",
  durationMs: 200_000,
  explicit: true,
  source: "srcp",
  sourceId: "s1",
};

// readSource → source provider, with OWNER ctx + the target verbatim
await deps.readSource("srcp", target);
assert(src.calls["readSourceTracks"]?.[0] === OWNER, "readSource passes the OWNER ctx");
assert(src.calls["readSourceTracks"]?.[1] === target, "readSource routes to the SOURCE provider with the target");

// readDestination → destination provider
await deps.readDestination("dstp", target);
assert(dst.calls["readDestinationTracks"] !== undefined, "readDestination routes to the DESTINATION provider");
assert(src.calls["readDestinationTracks"] === undefined, "readDestination does NOT call the source provider");

// createDestination → destination provider, name forwarded
await deps.createDestination("dstp", "My New Playlist");
assert(dst.calls["createPlaylistNamed"]?.[1] === "My New Playlist", "createDestination forwards the name to the dest provider");

// writeTracks → destination provider, ids forwarded
await deps.writeTracks("dstp", { kind: "liked" }, "PL9", ["a", "b"]);
const writeArgs = dst.calls["writeTracks"];
assert(Array.isArray(writeArgs?.[3]) && (writeArgs?.[3] as string[]).length === 2, "writeTracks forwards the dest ids to the dest provider");

// match → searches the DESTINATION provider (the refactor's core change), NOT
// the source. Source has an ISRC + dest supportsIsrc → Tier-1 then Tier-2.
await deps.match(source, false, "dstp");
const isrcArgs = dst.calls["searchByIsrc"];
assert(Array.isArray(isrcArgs?.[1]) && (isrcArgs?.[1] as string[])[0] === "USUG10000001", "match runs Tier-1 ISRC search on the DEST provider");
assert(dst.calls["searchByTerm"] !== undefined, "match falls through to Tier-2 search on the dest provider");
assert(src.calls["searchByIsrc"] === undefined, "match does NOT search the SOURCE provider (no opposite-platform inference)");

__clearRegistry();
__resetOperationDeps();
process.exit(process.exitCode ?? 0);

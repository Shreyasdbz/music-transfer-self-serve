// Operation runner — the additive one-way transfer (blueprint §8).
//
// read S → read D (+ §12.5 resume union) → per source track: skip-if-present /
// match / unmatched → apply staged writes in source order (batched happy path,
// per-track fallback for failure isolation + 404 auto-revalidation) → persist
// the full event log + summary. Additive only: never removes or reorders.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { HttpError } from "../util/http.js";
import { log, redact } from "../util/log.js";
import { SPOTIFY_ADD_BATCH, SPOTIFY_SAVE_BATCH } from "../clients/spotify.js";
import { APPLE_ADD_BATCH } from "../clients/apple.js";
import { identityKey, type CanonicalTrack } from "../match/identity.js";
import {
  finishOperation,
  insertOperation,
  insertOperationEvent,
  priorWrittenDestIds,
  type OperationStatus,
} from "../ledger/operationsStore.js";
import { getOperationDeps } from "./deps.js";
import type { OperationEventType, OperationSpec, OperationSummary, ResolvedTarget } from "./types.js";

export interface OperationHandle {
  readonly id: string;
  readonly done: Promise<OperationStatus>;
}

const emitters = new Map<string, EventEmitter>();
export function subscribeOperation(id: string): EventEmitter | undefined {
  return emitters.get(id);
}

function targetJson(t: ResolvedTarget): string {
  return JSON.stringify(t);
}

/** One staged write: a matched source→destination pair awaiting the write. */
interface Staged {
  readonly source: CanonicalTrack;
  readonly destId: string;
}

export function startOperation(spec: OperationSpec): OperationHandle {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  // May throw OperationRunningConflict (→ route 409) before the run starts.
  insertOperation({
    id,
    created_at: createdAt,
    source: spec.source,
    destination: spec.destination,
    source_target: targetJson(spec.sourceTarget),
    destination_target: targetJson(spec.destinationTarget),
    status: "running",
  });
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  emitters.set(id, emitter);

  let seq = 0;
  const summary: OperationSummary = { read: 0, matched: 0, skipped: 0, written: 0, unmatched: 0, failed: 0 };

  const emit = (type: OperationEventType, payload: Record<string, unknown>): void => {
    seq += 1;
    const ts = new Date().toISOString();
    const payloadJson = JSON.stringify(payload);
    insertOperationEvent({ operation_id: id, seq, ts, type, payload: payloadJson });
    emitter.emit("event", { seq, ts, type, payload });
  };

  const done = (async (): Promise<OperationStatus> => {
    const deps = getOperationDeps();
    try {
      emit("stage", { stage: "resolving_source" });
      const S = await deps.readSource(spec.source, spec.sourceTarget);
      summary.read = S.length;
      emit("stage", { stage: "source_read", count: S.length });

      // Resolve destination playlist id (create it now if needed) + read D.
      emit("stage", { stage: "reading_destination" });
      let destPlaylistId: string | undefined;
      if (spec.destinationTarget.kind === "playlist") destPlaylistId = spec.destinationTarget.id;
      else if (spec.destinationTarget.kind === "create") {
        destPlaylistId = await deps.createDestination(spec.destination, spec.destinationTarget.name);
        emit("stage", { stage: "destination_created", id: destPlaylistId });
      }

      const D = await deps.readDestination(spec.destination, spec.destinationTarget);
      const dKeys = new Set<string>(D.map((d) => identityKey(d.canonical)));
      // §12.5 resume soundness: union the live dest ids with ids written by
      // prior runs of this exact Operation tuple (handles eventual consistency
      // after a crash-then-resume). NOT applied to a freshly-`create`d
      // destination — a brand-new playlist has no prior contents, and the
      // create tuple's prior-write events belong to a DIFFERENT (now-orphaned)
      // playlist, so unioning them would wrongly skip every track and leave the
      // new playlist empty.
      const writtenDestIds = new Set<string>(D.map((d) => d.destId));
      if (spec.destinationTarget.kind !== "create") {
        for (const id of priorWrittenDestIds({
          source: spec.source,
          destination: spec.destination,
          source_target: targetJson(spec.sourceTarget),
          destination_target: targetJson(spec.destinationTarget),
        })) {
          writtenDestIds.add(id);
        }
      }
      emit("stage", { stage: "destination_read", count: D.length });

      // Match phase (source order).
      emit("stage", { stage: "matching" });
      const staged: Staged[] = [];
      for (const s of S) {
        const key = identityKey(s);
        if (dKeys.has(key)) {
          summary.skipped += 1;
          emit("skip", { source_id: s.sourceId, reason: "already_present", title: s.title });
          continue;
        }
        if (spec.rematch) deps.deleteCache(s);
        const result = await deps.match(s, !spec.rematch);
        if (result.tier === "unmatched" || !result.destination) {
          summary.unmatched += 1;
          emit("unmatched", {
            source_id: s.sourceId,
            title: s.title,
            artist: s.primaryArtist,
            rejected: result.rejected
              ? { id: result.rejected.canonical.sourceId, score: result.rejected.score.total }
              : null,
          });
          continue;
        }
        const destId = result.destination.id;
        summary.matched += 1;
        emit("match", {
          source_id: s.sourceId,
          dest_id: destId,
          tier: result.tier,
          confidence: result.confidence,
          from_cache: result.fromCache,
          title: s.title,
        });
        if (writtenDestIds.has(destId)) {
          // Already in the destination, written by a prior run, OR already
          // staged earlier in THIS run — two distinct source tracks (e.g. a
          // single-master ISRC and an album-master ISRC of the same recording,
          // which carry different identity keys) can resolve to the same
          // destination id. Adding `destId` to the set at STAGE time (below)
          // makes the second one skip here instead of double-appending.
          summary.skipped += 1;
          emit("skip", { source_id: s.sourceId, dest_id: destId, reason: "already_staged_or_present" });
          continue;
        }
        writtenDestIds.add(destId); // claim it now so a later dup is skipped
        staged.push({ source: s, destId });
      }

      // Write phase (source order). Batched happy path; per-track fallback on
      // any batch error for failure isolation + 404 auto-revalidation.
      emit("stage", { stage: "writing", count: staged.length });
      await applyWrites(spec, destPlaylistId, staged, deps, emit, summary, writtenDestIds);

      const status = computeStatus(summary);
      finishOperation(id, status, new Date().toISOString(), summary);
      emit("done", { status, summary });
      log.info("operation.complete", { id, status, ...summary });
      return status;
    } catch (err) {
      const message = String(redact((err as Error).message ?? String(err)));
      emit("error", { message });
      const status: OperationStatus = summary.written > 0 ? "partial" : "failed";
      finishOperation(id, status, new Date().toISOString(), summary);
      // Always end with a terminal `done` so SSE subscribers close cleanly,
      // even when the run aborts at the top level.
      emit("done", { status, summary, aborted: true });
      log.error("operation.failed", { id, message });
      return status;
    } finally {
      setTimeout(() => emitters.delete(id), 2000).unref?.();
    }
  })();

  return { id, done };
}

function computeStatus(s: OperationSummary): OperationStatus {
  if (s.failed === 0) return "succeeded";
  if (s.written > 0) return "partial";
  return "failed";
}

type Emit = (type: OperationEventType, payload: Record<string, unknown>) => void;

/** The write batch size for a destination — must equal the per-HTTP-request
 * size the client uses, because that request is the atomic unit. Chunking at
 * this size in the runner means a chunk failure only re-touches the tracks in
 * THAT chunk (each chunk = one request = all-or-nothing), so the per-track
 * fallback can never re-add an already-committed chunk → no duplicates from a
 * partial-batch failure. */
function writeChunkSize(spec: OperationSpec): number {
  if (spec.destination === "spotify") return spec.destinationTarget.kind === "liked" ? SPOTIFY_SAVE_BATCH : SPOTIFY_ADD_BATCH;
  return APPLE_ADD_BATCH;
}

async function applyWrites(
  spec: OperationSpec,
  destPlaylistId: string | undefined,
  staged: Staged[],
  deps: ReturnType<typeof getOperationDeps>,
  emit: Emit,
  summary: OperationSummary,
  writtenDestIds: Set<string>,
): Promise<void> {
  if (staged.length === 0) return;
  const chunkSize = writeChunkSize(spec);
  // Sequential chunks (Apple append-only requires no concurrent adds, §6.1).
  for (let i = 0; i < staged.length; i += chunkSize) {
    const chunk = staged.slice(i, i + chunkSize);
    try {
      // One chunk = one client HTTP request (the client's batch cap matches
      // chunkSize, so it makes exactly one call). Atomic: all land or none.
      await deps.writeTracks(spec.destination, spec.destinationTarget, destPlaylistId, chunk.map((x) => x.destId));
      for (const x of chunk) {
        summary.written += 1;
        writtenDestIds.add(x.destId);
        emit("write", { source_id: x.source.sourceId, dest_id: x.destId });
      }
    } catch {
      // This chunk's request failed (so none of it committed). Retry its
      // tracks ONE at a time so a single bad track doesn't sink the rest, and
      // a 404 on a stale cached id can be auto-revalidated. Prior chunks
      // already succeeded and are never re-touched.
      for (const x of chunk) {
        await writeOneWithRevalidation(spec, destPlaylistId, x, deps, emit, summary, writtenDestIds);
      }
    }
  }
}

async function writeOneWithRevalidation(
  spec: OperationSpec,
  destPlaylistId: string | undefined,
  x: Staged,
  deps: ReturnType<typeof getOperationDeps>,
  emit: Emit,
  summary: OperationSummary,
  writtenDestIds: Set<string>,
): Promise<void> {
  try {
    await deps.writeTracks(spec.destination, spec.destinationTarget, destPlaylistId, [x.destId]);
    summary.written += 1;
    writtenDestIds.add(x.destId);
    emit("write", { source_id: x.source.sourceId, dest_id: x.destId });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 0;
    if (status === 404) {
      // §12.5 auto-revalidation: the cached destination id no longer exists.
      // Invalidate that one cache row, re-resolve live, retry once.
      deps.deleteCache(x.source);
      try {
        const re = await deps.match(x.source, false);
        if (re.tier !== "unmatched" && re.destination) {
          const newId = re.destination.id;
          emit("match", { source_id: x.source.sourceId, dest_id: newId, tier: re.tier, confidence: re.confidence, from_cache: false, revalidated: true });
          await deps.writeTracks(spec.destination, spec.destinationTarget, destPlaylistId, [newId]);
          summary.written += 1;
          writtenDestIds.add(newId);
          emit("write", { source_id: x.source.sourceId, dest_id: newId, revalidated: true });
          return;
        }
      } catch {
        /* fall through to failed */
      }
    }
    summary.failed += 1;
    emit("error", { source_id: x.source.sourceId, dest_id: x.destId, kind: "write_failed", status });
  }
}

// Preflight orchestrator (blueprint §11.1). Shared by the UI's
// "Check permissions" button and the CLI `doctor` command.
//
// Ordering & skip semantics:
//   - `env` runs first (seq 1). If it fails, every downstream check is
//     recorded as `skip` with reason "prerequisite env failed".
//   - After env passes, the Spotify group (seq 2–5) and the Apple group
//     (seq 6–10) run IN PARALLEL. Within each group the checks run
//     sequentially; if the group's gating auth check (spotify_token /
//     apple_dev_token) fails, the rest of that group is `skip`.
//
// Each check result is persisted to `preflight_checks` and emitted live to
// any SSE subscriber. The seq is the check's fixed position in CHECKS so the
// row order is stable even though the two groups run concurrently.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { log } from "../util/log.js";
import {
  finishPreflightRun,
  insertPreflightCheck,
  insertPreflightRun,
  type CheckStatus,
  type PreflightStatus,
  type PreflightSurface,
  type PreflightTrigger,
} from "../ledger/preflightStore.js";
import { CHECKS, validateDetail, type CheckDef, type CheckName, type CheckResult } from "./checks.js";

export interface CheckEvent {
  readonly seq: number;
  readonly name: CheckName;
  readonly status: CheckStatus;
  readonly detail: Record<string, unknown>;
  readonly duration_ms: number;
}

export interface PreflightHandle {
  readonly id: string;
  /** Resolves with the final run status when all checks have completed. */
  readonly done: Promise<PreflightStatus>;
}

// In-process per-run emitters. SSE handlers subscribe; the runner emits a
// `check` event per check and a terminal `complete` event.
const emitters = new Map<string, EventEmitter>();

export function subscribePreflight(runId: string): EventEmitter | undefined {
  return emitters.get(runId);
}

const SEQ_BY_NAME: Record<CheckName, number> = Object.fromEntries(
  CHECKS.map((c, i) => [c.name, i + 1]),
) as Record<CheckName, number>;

function emit(runId: string, type: "check" | "complete", payload: unknown): void {
  emitters.get(runId)?.emit(type, payload);
}

function persistAndEmit(runId: string, def: CheckDef, result: CheckResult, durationMs: number): void {
  validateDetail(def.name, result.status, result.detail);
  const detailJson = JSON.stringify(result.detail);
  insertPreflightCheck({
    run_id: runId,
    seq: SEQ_BY_NAME[def.name],
    name: def.name,
    status: result.status,
    detail: detailJson,
    duration_ms: durationMs,
  });
  const evt: CheckEvent = {
    seq: SEQ_BY_NAME[def.name],
    name: def.name,
    status: result.status,
    detail: result.detail,
    duration_ms: durationMs,
  };
  emit(runId, "check", evt);
}

function skip(runId: string, def: CheckDef, reason: string): void {
  persistAndEmit(runId, def, { status: "skip", detail: { reason } }, 0);
}

async function runOne(runId: string, def: CheckDef): Promise<CheckStatus> {
  const start = Date.now();
  let result: CheckResult;
  try {
    result = await def.run();
  } catch (err) {
    // A check that throws unexpectedly is a fail, not a crash.
    log.warn("preflight.check_threw", { name: def.name, message: (err as Error).message });
    result = {
      status: "fail",
      detail: { error_class: (err as Error).name || "Error", error_message_safe: String((err as Error).message ?? err) },
    };
  }
  persistAndEmit(runId, def, result, Date.now() - start);
  return result.status;
}

/** Run a platform group sequentially; if the group's gate check fails, skip
 * the rest of the group. Returns the per-check statuses. */
async function runGroup(runId: string, group: "spotify" | "apple"): Promise<CheckStatus[]> {
  const defs = CHECKS.filter((c) => c.group === group);
  const statuses: CheckStatus[] = [];
  let gateFailed = false;
  let gateName = "";
  for (const def of defs) {
    if (gateFailed) {
      skip(runId, def, `prerequisite ${gateName} failed`);
      statuses.push("skip");
      continue;
    }
    const status = await runOne(runId, def);
    statuses.push(status);
    if (def.isGroupGate && status !== "pass") {
      gateFailed = true;
      gateName = def.name;
    }
  }
  return statuses;
}

function computeFinalStatus(statuses: CheckStatus[]): PreflightStatus {
  const fails = statuses.filter((s) => s === "fail").length;
  const passes = statuses.filter((s) => s === "pass").length;
  if (fails === 0) return "passed";
  if (passes > 0) return "partial";
  return "failed";
}

/** Start a preflight run. Returns the id immediately and a `done` promise.
 * Throws PreflightRunningConflict if one is already running. */
export function runPreflight(opts: { trigger: PreflightTrigger; surface: PreflightSurface }): PreflightHandle {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  // insertPreflightRun throws PreflightRunningConflict on a second 'running'
  // row — let it propagate to the caller (route → 409).
  insertPreflightRun({ id, started_at: startedAt, status: "running", trigger: opts.trigger, surface: opts.surface });
  emitters.set(id, new EventEmitter());

  const done = (async (): Promise<PreflightStatus> => {
    const allStatuses: CheckStatus[] = [];
    try {
      const envDef = CHECKS.find((c) => c.name === "env")!;
      const envStatus = await runOne(id, envDef);
      allStatuses.push(envStatus);

      if (envStatus !== "pass") {
        for (const def of CHECKS.filter((c) => c.group !== "env")) {
          skip(id, def, "prerequisite env failed");
          allStatuses.push("skip");
        }
      } else {
        const [spotify, apple] = await Promise.all([runGroup(id, "spotify"), runGroup(id, "apple")]);
        allStatuses.push(...spotify, ...apple);
      }

      const finalStatus = computeFinalStatus(allStatuses);
      const finishedAt = new Date().toISOString();
      finishPreflightRun(id, finalStatus, finishedAt);
      emit(id, "complete", { id, status: finalStatus, finished_at: finishedAt });
      log.info("preflight.complete", { id, status: finalStatus, surface: opts.surface });
      return finalStatus;
    } catch (err) {
      // Should not happen (runOne swallows check errors); guard so a stranded
      // 'running' row never blocks the next run.
      const finishedAt = new Date().toISOString();
      finishPreflightRun(id, "failed", finishedAt);
      emit(id, "complete", { id, status: "failed", finished_at: finishedAt });
      log.error("preflight.run_failed", { id, message: (err as Error).message });
      return "failed";
    } finally {
      // Give late SSE subscribers a tick to receive 'complete', then drop.
      setTimeout(() => emitters.delete(id), 2000).unref?.();
    }
  })();

  return { id, done };
}

// Ledger queries for the §9 `preflight_runs` + `preflight_checks` tables and
// the gate-state computation (§11.1 gating policy).
//
// The partial unique index `one_running_preflight` (WHERE status='running')
// means at most one run can be 'running' at a time — `insertPreflightRun`
// surfaces that as a typed conflict so the route can return 409.

import { openLedger } from "./db.js";

export type PreflightStatus = "running" | "passed" | "failed" | "partial" | "interrupted" | "invalidated";
export type PreflightTrigger = "manual" | "cli" | "auto-401" | "auto-403-scope";
export type PreflightSurface = "ui" | "cli";
export type CheckStatus = "pass" | "fail" | "skip";

export interface PreflightRunRow {
  readonly id: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly status: PreflightStatus;
  readonly trigger: PreflightTrigger;
  readonly surface: PreflightSurface;
}

export interface PreflightCheckRow {
  readonly run_id: string;
  readonly seq: number;
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string | null;
  readonly duration_ms: number | null;
}

export interface PreflightRunWithChecks extends PreflightRunRow {
  readonly checks: PreflightCheckRow[];
}

export class PreflightRunningConflict extends Error {
  constructor() {
    super("a preflight run is already running");
    this.name = "PreflightRunningConflict";
  }
}

export function insertPreflightRun(row: {
  id: string;
  started_at: string;
  status: PreflightStatus;
  trigger: PreflightTrigger;
  surface: PreflightSurface;
  finished_at?: string | null;
}): void {
  const db = openLedger();
  try {
    db.prepare(
      `INSERT INTO preflight_runs (id, started_at, finished_at, status, trigger, surface)
       VALUES (@id, @started_at, @finished_at, @status, @trigger, @surface)`,
    ).run({
      id: row.id,
      started_at: row.started_at,
      finished_at: row.finished_at ?? null,
      status: row.status,
      trigger: row.trigger,
      surface: row.surface,
    });
  } catch (err) {
    // The partial unique index fires SQLITE_CONSTRAINT_UNIQUE when a second
    // 'running' row is inserted.
    if ((err as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT") && row.status === "running") {
      throw new PreflightRunningConflict();
    }
    throw err;
  }
}

export function finishPreflightRun(id: string, status: PreflightStatus, finishedAt: string): void {
  openLedger()
    .prepare(`UPDATE preflight_runs SET status = ?, finished_at = ? WHERE id = ?`)
    .run(status, finishedAt, id);
}

export function insertPreflightCheck(row: PreflightCheckRow): void {
  openLedger()
    .prepare(
      `INSERT INTO preflight_checks (run_id, seq, name, status, detail, duration_ms)
       VALUES (@run_id, @seq, @name, @status, @detail, @duration_ms)`,
    )
    .run({
      run_id: row.run_id,
      seq: row.seq,
      name: row.name,
      status: row.status,
      detail: row.detail,
      duration_ms: row.duration_ms,
    });
}

function checksFor(runId: string): PreflightCheckRow[] {
  return openLedger()
    .prepare(
      `SELECT run_id, seq, name, status, detail, duration_ms
       FROM preflight_checks WHERE run_id = ? ORDER BY seq`,
    )
    .all(runId) as PreflightCheckRow[];
}

export function getPreflightRun(id: string): PreflightRunWithChecks | undefined {
  const row = openLedger()
    .prepare(`SELECT id, started_at, finished_at, status, trigger, surface FROM preflight_runs WHERE id = ?`)
    .get(id) as PreflightRunRow | undefined;
  if (!row) return undefined;
  return { ...row, checks: checksFor(id) };
}

/** Latest run by started_at (covers running rows too — the UI shows live
 * progress on the most recent). */
export function getLatestPreflightRun(): PreflightRunWithChecks | undefined {
  const row = openLedger()
    .prepare(
      `SELECT id, started_at, finished_at, status, trigger, surface
       FROM preflight_runs ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get() as PreflightRunRow | undefined;
  if (!row) return undefined;
  return { ...row, checks: checksFor(row.id) };
}

/** Insert an auto-invalidation marker row (status='invalidated'). started_at
 * and finished_at are both `now` so gate queries that order by time see it
 * immediately. */
export function insertInvalidation(id: string, trigger: PreflightTrigger, now: string): void {
  insertPreflightRun({
    id,
    started_at: now,
    finished_at: now,
    status: "invalidated",
    trigger,
    surface: "ui",
  });
}

export const GATE_TTL_MS = 24 * 60 * 60 * 1000;

export interface GateState {
  readonly open: boolean;
  readonly reason: string;
}

/**
 * Gate is OPEN iff:
 *   - a `passed` run exists, AND
 *   - its finished_at is within GATE_TTL_MS (soft 24h expiry), AND
 *   - no `invalidated` row was inserted after that pass.
 *
 * `nowMs` is injectable for tests.
 */
export function computeGateState(nowMs: number = Date.now()): GateState {
  const db = openLedger();
  const passed = db
    .prepare(
      `SELECT id, finished_at FROM preflight_runs
       WHERE status = 'passed' AND finished_at IS NOT NULL
       ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
    )
    .get() as { id: string; finished_at: string } | undefined;

  if (!passed) {
    return { open: false, reason: "No passing permissions check yet — run Check permissions." };
  }

  const ageMs = nowMs - Date.parse(passed.finished_at);
  if (ageMs > GATE_TTL_MS) {
    const hours = Math.floor(ageMs / (60 * 60 * 1000));
    return {
      open: false,
      reason: `Re-check permissions required: last pass was ${hours}h ago (soft 24h expiry).`,
    };
  }

  const invalidatedAfter = db
    .prepare(
      `SELECT trigger, started_at FROM preflight_runs
       WHERE status = 'invalidated' AND started_at > ?
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(passed.finished_at) as { trigger: string; started_at: string } | undefined;

  if (invalidatedAfter) {
    const why =
      invalidatedAfter.trigger === "auto-403-scope"
        ? "a scope/permission error"
        : "an auth failure";
    return {
      open: false,
      reason: `Re-check required: ${why} was detected since the last pass.`,
    };
  }

  return { open: true, reason: "Permissions check passed." };
}

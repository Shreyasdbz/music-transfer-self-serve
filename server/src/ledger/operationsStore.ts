// Ledger queries for the §9 `operations` + `operation_events` tables.
//
// One operation runs at a time (the `one_running_op` partial unique index);
// a second `running` insert raises OperationRunningConflict → route 409.
//
// The resume-soundness union (§12.5): the runner unions the live destination
// read `D` with the set of `write`-type events from PRIOR runs of the same
// (source, destination, sourceTarget, destinationTarget) tuple, so a
// crash-then-resume never re-writes an item that was already written but not
// yet visible in the platform's read (eventual consistency).

import { openLedger } from "./db.js";

export type OperationStatus = "running" | "succeeded" | "partial" | "failed" | "interrupted";

export interface OperationRow {
  readonly id: string;
  readonly created_at: string;
  readonly finished_at: string | null;
  readonly source: string;
  readonly destination: string;
  readonly source_target: string; // JSON
  readonly destination_target: string; // JSON
  readonly status: OperationStatus;
  readonly summary: string | null; // JSON
}

export interface OperationEventRow {
  readonly operation_id: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly payload: string | null; // JSON
}

export class OperationRunningConflict extends Error {
  constructor() {
    super("an operation is already running");
    this.name = "OperationRunningConflict";
  }
}

export function insertOperation(row: {
  id: string;
  created_at: string;
  source: string;
  destination: string;
  source_target: string;
  destination_target: string;
  status: OperationStatus;
}): void {
  const db = openLedger();
  try {
    db.prepare(
      `INSERT INTO operations (id, created_at, finished_at, source, destination, source_target, destination_target, status, summary)
       VALUES (@id, @created_at, NULL, @source, @destination, @source_target, @destination_target, @status, NULL)`,
    ).run(row);
  } catch (err) {
    if (
      (err as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT") &&
      row.status === "running"
    ) {
      throw new OperationRunningConflict();
    }
    throw err;
  }
}

export function finishOperation(
  id: string,
  status: OperationStatus,
  finishedAt: string,
  summary: unknown,
): void {
  openLedger()
    .prepare(`UPDATE operations SET status = ?, finished_at = ?, summary = ? WHERE id = ?`)
    .run(status, finishedAt, JSON.stringify(summary), id);
}

export function insertOperationEvent(row: OperationEventRow): void {
  openLedger()
    .prepare(
      `INSERT INTO operation_events (operation_id, seq, ts, type, payload)
       VALUES (@operation_id, @seq, @ts, @type, @payload)`,
    )
    .run(row);
}

export function getOperation(id: string): OperationRow | undefined {
  return openLedger()
    .prepare(
      `SELECT id, created_at, finished_at, source, destination, source_target, destination_target, status, summary FROM operations WHERE id = ?`,
    )
    .get(id) as OperationRow | undefined;
}

export function getOperationEvents(id: string, afterSeq = 0): OperationEventRow[] {
  return openLedger()
    .prepare(
      `SELECT operation_id, seq, ts, type, payload FROM operation_events WHERE operation_id = ? AND seq > ? ORDER BY seq`,
    )
    .all(id, afterSeq) as OperationEventRow[];
}

export function listOperations(limit = 50): OperationRow[] {
  return openLedger()
    .prepare(
      `SELECT id, created_at, finished_at, source, destination, source_target, destination_target, status, summary FROM operations ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(limit) as OperationRow[];
}

/**
 * §12.5 resume soundness: collect the destination ids written by PRIOR runs of
 * the same Operation tuple. `write`-type events carry
 * `{ dest_id: "<destination platform id>" }` in their payload; we return the
 * set so the runner can union it with the live `D` read and never duplicate
 * an append the platform read hasn't caught up to yet.
 */
export function priorWrittenDestIds(tuple: {
  source: string;
  destination: string;
  source_target: string;
  destination_target: string;
}): Set<string> {
  const db = openLedger();
  const rows = db
    .prepare(
      `SELECT e.payload AS payload
       FROM operation_events e
       JOIN operations o ON o.id = e.operation_id
       WHERE e.type = 'write'
         AND o.source = @source AND o.destination = @destination
         AND o.source_target = @source_target AND o.destination_target = @destination_target`,
    )
    .all(tuple) as { payload: string | null }[];
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.payload) continue;
    try {
      const p = JSON.parse(r.payload) as { dest_id?: string };
      if (p.dest_id) out.add(p.dest_id);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// Phase 1 AC #1 (schema_version + tables/indexes) and AC #4 (startup
// reconciliation sweep marks stranded `running` rows as `interrupted` and
// appends a final event row).
//
// Uses the real data/ledger.sqlite — like apple.test.ts, we snapshot and
// restore so the test never permanently mutates user state. Because better-
// sqlite3 doesn't expose an in-memory-only mode through our openLedger() API
// (the path is hardcoded to LEDGER_PATH), the snapshot-restore guard is
// the simplest correct approach.

import { closeLedger, openLedger, LATEST_SCHEMA_VERSION } from "./db.js";
import { LEDGER_PATH } from "../config.js";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";

const SNAPSHOT = LEDGER_PATH + ".test-snapshot";
const _hadLedger = existsSync(LEDGER_PATH);
if (_hadLedger) copyFileSync(LEDGER_PATH, SNAPSHOT);

function cleanup(): void {
  try {
    closeLedger();
  } catch {
    /* ignore */
  }
  if (_hadLedger) {
    copyFileSync(SNAPSHOT, LEDGER_PATH);
    try {
      unlinkSync(SNAPSHOT);
    } catch {
      /* ignore */
    }
  } else if (existsSync(LEDGER_PATH)) {
    try {
      unlinkSync(LEDGER_PATH);
    } catch {
      /* ignore */
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    process.stderr.write(`FAIL  ${msg}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS  ${msg}\n`);
  }
}

// ── AC #1 — schema_version + required tables/indexes ────────────────────

const db = openLedger();

const version = (db.prepare("SELECT version FROM schema_version").get() as { version: number }).version;
assert(version === LATEST_SCHEMA_VERSION, `AC1: schema_version = ${LATEST_SCHEMA_VERSION} (got ${version})`);

const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map((r) => r.name);
for (const t of ["tracks", "catalog", "preflight_runs", "preflight_checks", "operations", "operation_events", "schema_version"]) {
  assert(tables.includes(t), `AC1: table "${t}" present`);
}

const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'one_running%'").all() as { name: string }[])
  .map((r) => r.name);
assert(indexes.includes("one_running_op"), "AC1: partial unique index 'one_running_op' present");
assert(indexes.includes("one_running_preflight"), "AC1: partial unique index 'one_running_preflight' present");

// ── AC #4 — startup reconciliation sweep ─────────────────────────────────
//
// Seed a `running` row in each table with finished_at = NULL, close + reopen
// the ledger, and verify the sweep marks each as `interrupted` and appends a
// final `interrupted` event row to operations.

// Clear any test pollution from a previous run (snapshot covers it, but be
// defensive in case the snapshot logic skipped).
db.prepare("DELETE FROM operation_events WHERE operation_id LIKE 'ac4-test-%'").run();
db.prepare("DELETE FROM operations WHERE id LIKE 'ac4-test-%'").run();
db.prepare("DELETE FROM preflight_runs WHERE id LIKE 'ac4-test-%'").run();

const seededAt = new Date(Date.now() - 60_000).toISOString();
db.prepare(
  `INSERT INTO operations (id, created_at, source, destination, source_target, destination_target, status)
   VALUES (?, ?, 'spotify', 'apple', '{"kind":"liked"}', '{"kind":"playlist","name":"x"}', 'running')`,
).run("ac4-test-op", seededAt);
db.prepare(
  `INSERT INTO preflight_runs (id, started_at, status, trigger, surface)
   VALUES (?, ?, 'running', 'manual', 'ui')`,
).run("ac4-test-pf", seededAt);

const opBefore = db.prepare("SELECT status, finished_at FROM operations WHERE id=?").get("ac4-test-op") as { status: string; finished_at: string | null };
assert(opBefore.status === "running" && opBefore.finished_at === null, "AC4: seeded op is 'running' with finished_at NULL");

// Reopen — triggers the startup sweep.
closeLedger();
const db2 = openLedger();

const opAfter = db2.prepare("SELECT status, finished_at FROM operations WHERE id=?").get("ac4-test-op") as { status: string; finished_at: string | null };
assert(opAfter.status === "interrupted", `AC4: stranded op flipped to 'interrupted' (got ${opAfter.status})`);
assert(opAfter.finished_at !== null, "AC4: stranded op got finished_at set");

const pfAfter = db2.prepare("SELECT status, finished_at FROM preflight_runs WHERE id=?").get("ac4-test-pf") as { status: string; finished_at: string | null };
assert(pfAfter.status === "interrupted", `AC4: stranded preflight flipped to 'interrupted' (got ${pfAfter.status})`);

const evt = db2.prepare("SELECT seq, type, payload FROM operation_events WHERE operation_id=? ORDER BY seq").all("ac4-test-op") as { seq: number; type: string; payload: string }[];
assert(evt.length === 1, `AC4: exactly 1 event row appended (got ${evt.length})`);
assert(evt[0]?.type === "interrupted", `AC4: event row type = 'interrupted' (got ${evt[0]?.type})`);
const payload = JSON.parse(evt[0]!.payload);
assert(payload.reason === "server_restart_during_run", `AC4: event payload reason set (got ${payload.reason})`);

// Idempotency — reopen again, sweep should be a no-op (no new event rows).
closeLedger();
const db3 = openLedger();
const evt2 = db3.prepare("SELECT COUNT(*) AS n FROM operation_events WHERE operation_id=?").get("ac4-test-op") as { n: number };
assert(evt2.n === 1, `AC4: idempotent sweep — still exactly 1 event (got ${evt2.n})`);

closeLedger();

process.exit(process.exitCode ?? 0);

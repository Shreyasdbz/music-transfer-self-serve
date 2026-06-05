// Phase 1 AC #1 (schema_version + tables/indexes) and AC #4 (startup
// reconciliation sweep marks stranded `running` rows as `interrupted` and
// appends a final event row).
//
// Uses the real data/ledger.sqlite — like apple.test.ts, we snapshot and
// restore so the test never permanently mutates user state. Because better-
// sqlite3 doesn't expose an in-memory-only mode through our openLedger() API
// (the path is hardcoded to LEDGER_PATH), the snapshot-restore guard is
// the simplest correct approach.

import Database from "better-sqlite3";
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
for (const t of ["tracks", "catalog", "preflight_runs", "preflight_checks", "operations", "operation_events", "schema_version", "users", "track_provider_ids"]) {
  assert(tables.includes(t), `AC1: table "${t}" present`);
}

const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'one_running%'").all() as { name: string }[])
  .map((r) => r.name);
assert(indexes.includes("one_running_op"), "AC1: partial unique index 'one_running_op' present");
assert(indexes.includes("one_running_preflight"), "AC1: partial unique index 'one_running_preflight' present");

// ── v2 schema (migration #2) — users + user_id columns ──────────────────
const owner = db.prepare("SELECT id FROM users WHERE id = '__owner__'").get() as { id: string } | undefined;
assert(owner?.id === "__owner__", "v2: users table seeded with __owner__");
for (const tbl of ["catalog", "operations", "preflight_runs"]) {
  const cols = (db.prepare(`PRAGMA table_info(${tbl})`).all() as { name: string }[]).map((c) => c.name);
  assert(cols.includes("user_id"), `v2: ${tbl}.user_id column present`);
}

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

// ── Migration #2: real v1 ledger → v2, backfill + zero data loss ─────────
// Build a fresh v1 ledger (schema_version=1) with representative data, then
// reopen via openLedger() to run migration #2 and assert nothing is lost and
// the per-platform columns are backfilled into track_provider_ids.
for (const f of [LEDGER_PATH, `${LEDGER_PATH}-wal`, `${LEDGER_PATH}-shm`]) {
  if (existsSync(f)) unlinkSync(f);
}

const v1 = new Database(LEDGER_PATH);
v1.exec(`
  CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
  CREATE TABLE tracks ( identity_key TEXT PRIMARY KEY, isrc TEXT, norm_title TEXT, norm_artist TEXT, duration_ms INTEGER, spotify_id TEXT, apple_catalog_id TEXT, apple_library_id TEXT, match_tier TEXT, confidence INTEGER, updated_at TEXT );
  CREATE TABLE catalog ( platform TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT, owner TEXT, track_count INTEGER, url TEXT, fetched_at TEXT, PRIMARY KEY (platform, kind, external_id) );
  CREATE TABLE preflight_runs ( id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, trigger TEXT NOT NULL, surface TEXT NOT NULL );
  CREATE TABLE preflight_checks ( run_id TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, duration_ms INTEGER, PRIMARY KEY (run_id, seq) );
  CREATE TABLE operations ( id TEXT PRIMARY KEY, created_at TEXT NOT NULL, finished_at TEXT, source TEXT NOT NULL, destination TEXT NOT NULL, source_target TEXT NOT NULL, destination_target TEXT NOT NULL, status TEXT NOT NULL, summary TEXT );
  CREATE TABLE operation_events ( operation_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL, payload TEXT, PRIMARY KEY (operation_id, seq) );
`);
const nowIso = new Date().toISOString();
v1.prepare("INSERT INTO schema_version(version) VALUES (1)").run();
// Two v1-cached tracks: one with both ids (spotify→apple), one spotify-only.
v1.prepare("INSERT INTO tracks (identity_key, isrc, norm_title, norm_artist, duration_ms, spotify_id, apple_catalog_id, apple_library_id, match_tier, confidence, updated_at) VALUES ('isrc:MIGV1000001','MIGV1000001','t1','a1',200000,'sp-mig-1','ap-mig-1',NULL,'isrc',100,?)").run(nowIso);
v1.prepare("INSERT INTO tracks (identity_key, isrc, norm_title, norm_artist, duration_ms, spotify_id, apple_catalog_id, apple_library_id, match_tier, confidence, updated_at) VALUES ('isrc:MIGV1000002','MIGV1000002','t2','a2',180000,'sp-mig-2',NULL,NULL,'isrc',100,?)").run(nowIso);
v1.prepare("INSERT INTO catalog (platform, kind, external_id, name, fetched_at) VALUES ('spotify','playlist','pl-1','My PL',?)").run(nowIso);
v1.prepare("INSERT INTO operations (id, created_at, source, destination, source_target, destination_target, status) VALUES ('op-mig-1',?,'spotify','apple','{\"kind\":\"liked\"}','{\"kind\":\"favorites\"}','succeeded')").run(nowIso);
const n = (sql: string): number => (v1.prepare(sql).get() as { n: number }).n;
const tracksBefore = n("SELECT COUNT(*) n FROM tracks");
const catalogBefore = n("SELECT COUNT(*) n FROM catalog");
const opsBefore = n("SELECT COUNT(*) n FROM operations");
v1.close();

// Reopen via the real openLedger → applies migration #2.
const mdb = openLedger();
const mver = (mdb.prepare("SELECT version FROM schema_version").get() as { version: number }).version;
assert(mver === 2, `migration: v1 ledger upgraded to schema_version 2 (got ${mver})`);

const m = (sql: string): number => (mdb.prepare(sql).get() as { n: number }).n;
assert(m("SELECT COUNT(*) n FROM tracks") === tracksBefore, "migration: tracks row count unchanged (zero data loss)");
assert(m("SELECT COUNT(*) n FROM catalog") === catalogBefore, "migration: catalog row count unchanged");
assert(m("SELECT COUNT(*) n FROM operations") === opsBefore, "migration: operations row count unchanged");

const ref = (k: string, p: string): string | undefined =>
  (mdb.prepare("SELECT provider_ref r FROM track_provider_ids WHERE identity_key=? AND provider_id=? AND provider_kind='default'").get(k, p) as { r: string } | undefined)?.r;
assert(ref("isrc:MIGV1000001", "spotify") === "sp-mig-1", "migration backfill: spotify_id → track_provider_ids");
assert(ref("isrc:MIGV1000001", "apple") === "ap-mig-1", "migration backfill: apple_catalog_id → track_provider_ids");
assert(ref("isrc:MIGV1000002", "spotify") === "sp-mig-2", "migration backfill: spotify-only track backfilled");
assert(ref("isrc:MIGV1000002", "apple") === undefined, "migration backfill: no apple ref for a spotify-only track");
assert(m("SELECT COUNT(*) n FROM track_provider_ids") === 3, `migration backfill: 3 provider refs created (2 spotify + 1 apple)`);

const opUser = (mdb.prepare("SELECT user_id FROM operations WHERE id='op-mig-1'").get() as { user_id: string }).user_id;
assert(opUser === "__owner__", `migration: existing operations row backfilled user_id=__owner__ (got ${opUser})`);

closeLedger();

process.exit(process.exitCode ?? 0);

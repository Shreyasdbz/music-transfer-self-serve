// SQLite ledger per blueprint §9 + §12.5.
//
// On open:
//   1. Ensure data/ exists with mode 0700.
//   2. Open the DB; set WAL + foreign_keys + synchronous=NORMAL PRAGMAs.
//   3. Tighten file perms (0600) on the .sqlite/-wal/-shm files.
//   4. Run forward-only migrations from `schema_version` → LATEST_VERSION.
//   5. Run the startup reconciliation sweep (§12.5).
//
// All migrations are version-numbered, wrapped in a transaction, and end by
// upserting the new version row. Never write a down-migration.

import Database, { type Database as DB } from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DATA_DIR, LEDGER_PATH } from "../config.js";
import { log } from "../util/log.js";

export const LATEST_SCHEMA_VERSION = 1;

type Migration = (db: DB) => void;

const MIGRATIONS: Record<number, Migration> = {
  1: (db) => {
    db.exec(`
      CREATE TABLE tracks (
        identity_key      TEXT PRIMARY KEY,
        isrc              TEXT,
        norm_title        TEXT,
        norm_artist       TEXT,
        duration_ms       INTEGER,
        spotify_id        TEXT,
        apple_catalog_id  TEXT,
        apple_library_id  TEXT,
        match_tier        TEXT,
        confidence        INTEGER,
        updated_at        TEXT
      );

      CREATE TABLE catalog (
        platform     TEXT NOT NULL,
        kind         TEXT NOT NULL,
        external_id  TEXT NOT NULL,
        name         TEXT,
        owner        TEXT,
        track_count  INTEGER,
        url          TEXT,
        fetched_at   TEXT,
        PRIMARY KEY (platform, kind, external_id)
      );

      CREATE TABLE preflight_runs (
        id          TEXT PRIMARY KEY,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        status      TEXT NOT NULL,
        trigger     TEXT NOT NULL,
        surface     TEXT NOT NULL
      );

      CREATE UNIQUE INDEX one_running_preflight ON preflight_runs(status)
        WHERE status = 'running';

      CREATE TABLE preflight_checks (
        run_id      TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        name        TEXT NOT NULL,
        status      TEXT NOT NULL,
        detail      TEXT,
        duration_ms INTEGER,
        PRIMARY KEY (run_id, seq)
      );

      CREATE TABLE operations (
        id                 TEXT PRIMARY KEY,
        created_at         TEXT NOT NULL,
        finished_at        TEXT,
        source             TEXT NOT NULL,
        destination        TEXT NOT NULL,
        source_target      TEXT NOT NULL,
        destination_target TEXT NOT NULL,
        status             TEXT NOT NULL,
        summary            TEXT
      );

      CREATE UNIQUE INDEX one_running_op ON operations(status) WHERE status = 'running';

      CREATE INDEX preflight_runs_finished ON preflight_runs(finished_at DESC);
      CREATE INDEX operations_finished ON operations(finished_at DESC);

      CREATE TABLE operation_events (
        operation_id TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        ts           TEXT NOT NULL,
        type         TEXT NOT NULL,
        payload      TEXT,
        PRIMARY KEY (operation_id, seq)
      );
    `);
  },
};

function ensureDir(path: string, mode: number): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode });
  }
  try {
    chmodSync(path, mode);
  } catch {
    // Windows or restricted FS — no-op (documented in README).
  }
}

function tightenFilePerms(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) {
      try {
        chmodSync(candidate, 0o600);
      } catch {
        // Non-POSIX or restricted FS — no-op.
      }
    }
  }
}

function getCurrentVersion(db: DB): number {
  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined;
  return row?.version ?? 0;
}

function setVersion(db: DB, version: number): void {
  db.prepare("INSERT OR REPLACE INTO schema_version(version) VALUES (?)").run(version);
}

function runMigrations(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);
  const current = getCurrentVersion(db);
  for (let v = current + 1; v <= LATEST_SCHEMA_VERSION; v++) {
    const migration = MIGRATIONS[v];
    if (!migration) {
      throw new Error(`Missing migration for schema version ${v}`);
    }
    const tx = db.transaction(() => {
      migration(db);
      setVersion(db, v);
    });
    tx();
    log.info("ledger.migration_applied", { version: v });
  }
}

/** §12.5 startup reconciliation sweep — mark stranded `running` rows as
 * `interrupted`. Run in a single transaction so the partial unique indexes
 * never see a transient invalid state. */
function reconcileStrandedRunning(db: DB): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const ops = db
      .prepare(
        "SELECT id FROM operations WHERE status = 'running' AND finished_at IS NULL",
      )
      .all() as { id: string }[];
    const updateOp = db.prepare(
      "UPDATE operations SET status = 'interrupted', finished_at = ? WHERE id = ?",
    );
    const nextSeq = db.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM operation_events WHERE operation_id = ?",
    );
    const insertEvt = db.prepare(
      "INSERT INTO operation_events(operation_id, seq, ts, type, payload) VALUES (?, ?, ?, 'interrupted', ?)",
    );
    for (const { id } of ops) {
      updateOp.run(now, id);
      const { n } = nextSeq.get(id) as { n: number };
      insertEvt.run(id, n, now, JSON.stringify({ reason: "server_restart_during_run" }));
    }

    const pfRuns = db
      .prepare(
        "SELECT id FROM preflight_runs WHERE status = 'running' AND finished_at IS NULL",
      )
      .all() as { id: string }[];
    const updatePf = db.prepare(
      "UPDATE preflight_runs SET status = 'interrupted', finished_at = ? WHERE id = ?",
    );
    for (const { id } of pfRuns) {
      updatePf.run(now, id);
    }

    if (ops.length || pfRuns.length) {
      log.info("ledger.reconciled_stranded_running", {
        operations: ops.length,
        preflight_runs: pfRuns.length,
      });
    }
  });
  tx();
}

let dbInstance: DB | undefined;

export function openLedger(): DB {
  if (dbInstance) return dbInstance;

  ensureDir(DATA_DIR, 0o700);
  ensureDir(dirname(LEDGER_PATH), 0o700);

  const db = new Database(LEDGER_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  tightenFilePerms(LEDGER_PATH);

  runMigrations(db);
  reconcileStrandedRunning(db);

  // After migrations open the WAL files, re-tighten perms in case they were
  // newly created by the first transaction.
  tightenFilePerms(LEDGER_PATH);

  dbInstance = db;
  return db;
}

export function closeLedger(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = undefined;
  }
}

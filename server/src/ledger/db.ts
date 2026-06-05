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

export const LATEST_SCHEMA_VERSION = 2;

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

  // v2 (blueprint §15 A2): multi-user-ready data seam + generalized provider-id
  // storage. Forward-only, INSERT/ALTER-ADD only — NO row is deleted or
  // rewritten, so a real v1 ledger migrates with zero data loss.
  2: (db) => {
    const now = new Date().toISOString();
    db.exec(`
      -- Explicit user dimension; single owner today (A2 seam — not multi-user yet).
      CREATE TABLE users (
        id         TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      -- Generalized (identity_key, provider) to write-id mapping, replacing the
      -- per-platform spotify_id / apple_catalog_id / apple_library_id columns on
      -- the tracks table. Those columns are LEFT IN PLACE (SQLite drop-column is
      -- awkward and they harm nothing); new code reads/writes here. provider_kind
      -- keeps the apple catalog-vs-library distinction; matching uses 'default'.
      CREATE TABLE track_provider_ids (
        identity_key  TEXT NOT NULL,
        provider_id   TEXT NOT NULL,
        provider_kind TEXT NOT NULL DEFAULT 'default',
        provider_ref  TEXT NOT NULL,
        PRIMARY KEY (identity_key, provider_id, provider_kind),
        FOREIGN KEY (identity_key) REFERENCES tracks(identity_key) ON DELETE CASCADE
      );

      CREATE INDEX track_provider_ids_by_provider
        ON track_provider_ids(provider_id, provider_ref);
    `);

    db.prepare("INSERT OR IGNORE INTO users(id, created_at) VALUES ('__owner__', ?)").run(now);

    // Backfill from the v1 per-platform columns (INSERT-only; zero data loss).
    // spotify_id and apple_catalog_id are the matcher's write ids → 'default';
    // apple_library_id (effectively always NULL in v1) keeps kind 'library'.
    db.exec(`
      INSERT OR IGNORE INTO track_provider_ids(identity_key, provider_id, provider_kind, provider_ref)
        SELECT identity_key, 'spotify', 'default', spotify_id FROM tracks WHERE spotify_id IS NOT NULL;
      INSERT OR IGNORE INTO track_provider_ids(identity_key, provider_id, provider_kind, provider_ref)
        SELECT identity_key, 'apple', 'default', apple_catalog_id FROM tracks WHERE apple_catalog_id IS NOT NULL;
      INSERT OR IGNORE INTO track_provider_ids(identity_key, provider_id, provider_kind, provider_ref)
        SELECT identity_key, 'apple', 'library', apple_library_id FROM tracks WHERE apple_library_id IS NOT NULL;
    `);

    // Multi-user-ready: user dimension on user-scoped tables. Single owner now,
    // so a constant DEFAULT backfills every existing row. The catalog PK rebuild
    // to include user_id is DEFERRED until multi-user is activated (single owner
    // can't collide); same for per-user scoping of reads. ALTER ADD COLUMN with a
    // constant default is a metadata-only change in SQLite (no row rewrite).
    db.exec(`
      ALTER TABLE catalog        ADD COLUMN user_id TEXT NOT NULL DEFAULT '__owner__';
      ALTER TABLE operations     ADD COLUMN user_id TEXT NOT NULL DEFAULT '__owner__';
      ALTER TABLE preflight_runs ADD COLUMN user_id TEXT NOT NULL DEFAULT '__owner__';
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
  // MAX, not LIMIT 1: defensive against any ledger that accumulated multiple
  // schema_version rows under the old INSERT-OR-REPLACE bug (the PK is the
  // version itself, so OR-REPLACE inserted a new row instead of replacing).
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}

function setVersion(db: DB, version: number): void {
  // Keep schema_version a single-row table. INSERT OR REPLACE does NOT replace
  // here (the PK is `version`, so a new version is a new row), so delete first.
  db.prepare("DELETE FROM schema_version").run();
  db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(version);
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

/** Open a ledger at `path`, set PRAGMAs, run forward migrations + the startup
 * sweep, and tighten perms. Pure of the process-wide singleton — used by
 * openLedger() and by the test seam below. */
function openAndMigrate(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  tightenFilePerms(path);

  runMigrations(db);
  reconcileStrandedRunning(db);

  // After migrations open the WAL files, re-tighten perms in case they were
  // newly created by the first transaction.
  tightenFilePerms(path);

  return db;
}

export function openLedger(): DB {
  if (dbInstance) return dbInstance;

  ensureDir(DATA_DIR, 0o700);
  ensureDir(dirname(LEDGER_PATH), 0o700);

  dbInstance = openAndMigrate(LEDGER_PATH);
  return dbInstance;
}

export function closeLedger(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = undefined;
  }
}

/** Test-only: open + migrate a ledger at an ARBITRARY path without touching the
 * process-wide singleton or the real ledger. Lets migration tests run against a
 * throwaway temp ledger so they can never corrupt the user's real one. Caller
 * must close the returned handle. */
export function __openLedgerAt(path: string): DB {
  return openAndMigrate(path);
}

/** Test-only: install (or clear with `undefined`) the singleton so the rest of
 * the engine (matcher cache, stores) reads `db`. Used to point matchToDestination
 * at a migrated temp ledger for end-to-end backfill tests. */
export function __setLedgerInstance(db: DB | undefined): void {
  dbInstance = db;
}

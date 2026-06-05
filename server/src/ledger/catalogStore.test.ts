// catalogStore unit tests: upsert/get, sentinels, stale-removal, and the §9
// name-match used for free-text disambiguation. Snapshot/restore the ledger.

import { existsSync, copyFileSync, unlinkSync } from "node:fs";
import { LEDGER_PATH } from "../config.js";
import { closeLedger, openLedger } from "./db.js";
import {
  deleteStaleCatalogRows,
  findCatalogByName,
  getCatalog,
  getCatalogByPlatform,
  lastFetchedAt,
  normalizeName,
  upsertCatalogRow,
  LIKED_SENTINEL,
  FAVORITES_SENTINEL,
} from "./catalogStore.js";

const SNAP = LEDGER_PATH + ".catalog-test-snap";
const _had = existsSync(LEDGER_PATH);
if (_had) copyFileSync(LEDGER_PATH, SNAP);
// Idempotency latch: on SIGINT we restore then process.exit(130), which fires
// the 'exit' handler → restore() again. Without the latch the second pass
// would copyFileSync from an already-unlinked snapshot and throw ENOENT from
// inside an exit handler.
let restored = false;
function restore(): void {
  if (restored) return;
  restored = true;
  try {
    closeLedger();
  } catch {
    /* */
  }
  if (_had && existsSync(SNAP)) {
    copyFileSync(SNAP, LEDGER_PATH);
    try {
      unlinkSync(SNAP);
    } catch {
      /* */
    }
  } else if (!_had && existsSync(LEDGER_PATH)) {
    try {
      unlinkSync(LEDGER_PATH);
    } catch {
      /* */
    }
  }
}
process.on("exit", restore);
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

function assert(c: unknown, m: string): void {
  if (!c) {
    process.stderr.write(`FAIL  ${m}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS  ${m}\n`);
}

const db = openLedger();
db.prepare("DELETE FROM catalog").run();

const T1 = "2026-06-04T10:00:00.000Z";

// ── normalizeName (§9: trim + collapse + casefold) ───────────────────────
assert(
  normalizeName("  My   Playlist  ") === "my playlist",
  "normalizeName: trim+collapse+casefold",
);
assert(normalizeName("WORKOUT") === "workout", "normalizeName: casefold");

// ── upsert + read-back ───────────────────────────────────────────────────
upsertCatalogRow({
  platform: "spotify",
  kind: "playlist",
  external_id: "sp1",
  name: "Workout",
  owner: "me",
  track_count: 12,
  url: "u",
  fetched_at: T1,
});
upsertCatalogRow({
  platform: "spotify",
  kind: "liked",
  external_id: LIKED_SENTINEL,
  name: "Liked Songs",
  owner: null,
  track_count: 1623,
  url: null,
  fetched_at: T1,
});
upsertCatalogRow({
  platform: "apple",
  kind: "favorites",
  external_id: FAVORITES_SENTINEL,
  name: "Favorite Songs",
  owner: null,
  track_count: null,
  url: null,
  fetched_at: T1,
});

const all = getCatalog();
assert(all.length === 3, `getCatalog: 3 rows (got ${all.length})`);
const sp = getCatalogByPlatform("spotify");
assert(sp.length === 2, `getCatalogByPlatform spotify: 2 (got ${sp.length})`);
assert(
  sp.some((r) => r.kind === "liked" && r.external_id === LIKED_SENTINEL),
  "sentinel: liked row present",
);

// upsert overwrites mutable fields
upsertCatalogRow({
  platform: "spotify",
  kind: "playlist",
  external_id: "sp1",
  name: "Workout",
  owner: "me",
  track_count: 15,
  url: "u",
  fetched_at: T1,
});
assert(
  getCatalogByPlatform("spotify").find((r) => r.external_id === "sp1")?.track_count === 15,
  "upsert: track_count updated",
);

assert(lastFetchedAt("spotify") === T1, "lastFetchedAt");

// ── findCatalogByName (§9 disambiguation source) ─────────────────────────
upsertCatalogRow({
  platform: "spotify",
  kind: "playlist",
  external_id: "sp2",
  name: "workout",
  owner: "me",
  track_count: 5,
  url: null,
  fetched_at: T1,
}); // dup name, different case
const matches = findCatalogByName("spotify", "  WORKOUT ");
assert(
  matches.length === 2,
  `findCatalogByName: case/space-insensitive match → 2 (got ${matches.length})`,
);
assert(findCatalogByName("spotify", "nonexistent").length === 0, "findCatalogByName: no match → 0");
assert(
  findCatalogByName("spotify", "Liked Songs").length === 0,
  "findCatalogByName: ignores liked/favorites rows",
);

// ── stale removal ────────────────────────────────────────────────────────
const T2 = "2026-06-04T11:00:00.000Z";
upsertCatalogRow({
  platform: "spotify",
  kind: "playlist",
  external_id: "sp1",
  name: "Workout",
  owner: "me",
  track_count: 15,
  url: "u",
  fetched_at: T2,
}); // refreshed
// sp2 + liked still at T1 → stale relative to T2
deleteStaleCatalogRows("spotify", T2);
const afterStale = getCatalogByPlatform("spotify");
assert(
  afterStale.length === 1 && afterStale[0]?.external_id === "sp1",
  `stale removal: only T2 row kept (got ${afterStale.map((r) => r.external_id).join(",")})`,
);
// apple untouched
assert(getCatalogByPlatform("apple").length === 1, "stale removal: other platform untouched");

process.exit(process.exitCode ?? 0);

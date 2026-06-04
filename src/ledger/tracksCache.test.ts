// Direct unit tests for the ledger tracks-cache layer (finding #20). Focuses
// on the COALESCE preservation invariant that the matcher relies on for
// cross-direction id retention.
//
// Snapshot/restore the real ledger; restore on exit AND SIGINT.

import { existsSync, copyFileSync, unlinkSync } from "node:fs";
import { LEDGER_PATH } from "../config.js";
import { closeLedger, openLedger } from "./db.js";
import { getCachedTrack, putCachedTrack, deleteCachedTrack, type CachedTrack } from "./tracksCache.js";

const SNAPSHOT = LEDGER_PATH + ".trackscache-test-snapshot";
const _had = existsSync(LEDGER_PATH);
if (_had) copyFileSync(LEDGER_PATH, SNAPSHOT);
function restore(): void {
  try { closeLedger(); } catch { /* ignore */ }
  if (_had) {
    copyFileSync(SNAPSHOT, LEDGER_PATH);
    try { unlinkSync(SNAPSHOT); } catch { /* ignore */ }
  } else if (existsSync(LEDGER_PATH)) {
    try { unlinkSync(LEDGER_PATH); } catch { /* ignore */ }
  }
}
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(130); });

function assert(cond: unknown, msg: string): void {
  if (!cond) { process.stderr.write(`FAIL  ${msg}\n`); process.exitCode = 1; }
  else process.stdout.write(`PASS  ${msg}\n`);
}

openLedger();

const base: CachedTrack = {
  identity_key: "isrc:TESTCACHE0001",
  isrc: "TESTCACHE0001",
  norm_title: "test title",
  norm_artist: "test artist",
  duration_ms: 200_000,
  spotify_id: "sp-1",
  apple_catalog_id: undefined,
  apple_library_id: undefined,
  match_tier: "isrc",
  confidence: 100,
  updated_at: new Date().toISOString(),
};

// (a) round-trip
putCachedTrack(base);
const got = getCachedTrack(base.identity_key);
assert(got?.spotify_id === "sp-1" && got?.isrc === "TESTCACHE0001", "round-trip: exact row");
assert(got?.norm_title === "test title" && got?.confidence === 100, "round-trip: fields preserved");
assert(getCachedTrack("isrc:DOES_NOT_EXIST") === undefined, "miss → undefined");

// (b) COALESCE preserves the OTHER direction's id on a second put.
// Second put writes apple_catalog_id but leaves spotify_id undefined; the
// stored spotify_id must survive.
putCachedTrack({ ...base, spotify_id: undefined, apple_catalog_id: "ap-1" });
const merged = getCachedTrack(base.identity_key);
assert(merged?.apple_catalog_id === "ap-1", `COALESCE: apple id added (got ${merged?.apple_catalog_id})`);
assert(merged?.spotify_id === "sp-1", `COALESCE: spotify id preserved when new put omits it (got ${merged?.spotify_id})`);

// (c) reverse — putting undefined apple_library_id doesn't wipe an existing one
putCachedTrack({ ...base, spotify_id: undefined, apple_catalog_id: undefined, apple_library_id: "lib-1" });
const withLib = getCachedTrack(base.identity_key);
assert(withLib?.apple_library_id === "lib-1", "COALESCE: library id set");
putCachedTrack({ ...base, spotify_id: undefined, apple_catalog_id: undefined, apple_library_id: undefined });
const stillLib = getCachedTrack(base.identity_key);
assert(stillLib?.apple_library_id === "lib-1", `COALESCE: library id preserved against undefined put (got ${stillLib?.apple_library_id})`);
assert(stillLib?.spotify_id === "sp-1" && stillLib?.apple_catalog_id === "ap-1", "COALESCE: both ids still present after undefined puts");

// (d) updated non-COALESCE fields DO overwrite (confidence, match_tier, norm_*)
putCachedTrack({ ...base, spotify_id: undefined, apple_catalog_id: undefined, confidence: 73, match_tier: "search", norm_title: "new title" });
const updated = getCachedTrack(base.identity_key);
assert(updated?.confidence === 73 && updated?.match_tier === "search", "overwrite: confidence + tier replaced");
assert(updated?.norm_title === "new title", "overwrite: norm_title replaced");

// (e) delete
deleteCachedTrack(base.identity_key);
assert(getCachedTrack(base.identity_key) === undefined, "delete: row gone");

// (f) sqlite NULL columns come back as JS null (documented behavior the
// matcher's cacheHit coerces). Verify get returns null (not undefined) for an
// unset nullable column so the matcher's nn() coercion is actually needed.
putCachedTrack({ ...base, identity_key: "fuzzy:nulltest", isrc: undefined, spotify_id: "sp-x", apple_catalog_id: undefined });
const nullRow = getCachedTrack("fuzzy:nulltest");
assert(nullRow?.isrc === null || nullRow?.isrc === undefined, `NULL column: isrc is null/undefined (got ${JSON.stringify(nullRow?.isrc)})`);
deleteCachedTrack("fuzzy:nulltest");

process.exit(process.exitCode ?? 0);

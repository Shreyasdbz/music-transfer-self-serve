// Direct unit tests for the ledger tracks-cache layer (v2: generalized onto
// track_provider_ids). Covers identity round-trip, per-provider write-id
// put/get, upsert, provider_kind distinction, and delete-cascade.
//
// Snapshot/restore the real ledger; restore on exit AND SIGINT.

import { existsSync, copyFileSync, unlinkSync } from "node:fs";
import { LEDGER_PATH } from "../config.js";
import { closeLedger, openLedger } from "./db.js";
import {
  getCachedTrack,
  putCachedTrack,
  deleteCachedTrack,
  putProviderRef,
  getProviderRef,
  type CachedTrack,
} from "./tracksCache.js";

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
  match_tier: "isrc",
  confidence: 100,
  updated_at: new Date().toISOString(),
};

// (a) identity round-trip
putCachedTrack(base);
const got = getCachedTrack(base.identity_key);
assert(got?.isrc === "TESTCACHE0001" && got?.norm_title === "test title", "round-trip: identity fields");
assert(got?.confidence === 100 && got?.match_tier === "isrc", "round-trip: match metadata");
assert(getCachedTrack("isrc:DOES_NOT_EXIST") === undefined, "miss → undefined");

// (b) per-provider write-ids: distinct providers coexist (bidirectional cache)
putProviderRef(base.identity_key, "spotify", "sp-1");
putProviderRef(base.identity_key, "apple", "ap-1");
assert(getProviderRef(base.identity_key, "spotify") === "sp-1", "provider ref: spotify");
assert(getProviderRef(base.identity_key, "apple") === "ap-1", "provider ref: apple coexists with spotify");
assert(getProviderRef(base.identity_key, "youtube") === undefined, "provider ref: missing provider → undefined");

// (c) upsert overwrites the same (key, provider, kind)
putProviderRef(base.identity_key, "apple", "ap-2");
assert(getProviderRef(base.identity_key, "apple") === "ap-2", "provider ref: upsert overwrites");
assert(getProviderRef(base.identity_key, "spotify") === "sp-1", "provider ref: upsert leaves other provider intact");

// (d) provider_kind distinguishes the matching id from Apple's library id
putProviderRef(base.identity_key, "apple", "lib-1", "library");
assert(getProviderRef(base.identity_key, "apple") === "ap-2", "provider_kind: default id unchanged");
assert(getProviderRef(base.identity_key, "apple", "library") === "lib-1", "provider_kind: library id separate");

// (e) identity re-put overwrites match metadata (provider refs untouched)
putCachedTrack({ ...base, confidence: 73, match_tier: "search", norm_title: "new title" });
const updated = getCachedTrack(base.identity_key);
assert(updated?.confidence === 73 && updated?.match_tier === "search", "overwrite: confidence + tier replaced");
assert(updated?.norm_title === "new title", "overwrite: norm_title replaced");
assert(getProviderRef(base.identity_key, "spotify") === "sp-1", "overwrite: provider refs survive identity re-put");

// (f) delete cascades the provider refs (FK ON DELETE CASCADE)
deleteCachedTrack(base.identity_key);
assert(getCachedTrack(base.identity_key) === undefined, "delete: identity row gone");
assert(getProviderRef(base.identity_key, "spotify") === undefined, "delete: provider refs cascaded away");
assert(getProviderRef(base.identity_key, "apple") === undefined, "delete: all provider refs cascaded");

process.exit(process.exitCode ?? 0);

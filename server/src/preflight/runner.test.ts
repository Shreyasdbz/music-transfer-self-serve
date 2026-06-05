// Runner orchestration tests that don't need live API tokens:
//   - env-fail → every downstream check recorded as `skip` (AC #3 logic)
//   - final status computation
//   - one-running conflict surfaces
// Snapshot/restore the real ledger.

import { existsSync, copyFileSync, unlinkSync } from "node:fs";
import { LEDGER_PATH } from "../config.js";
import { closeLedger, openLedger } from "../ledger/db.js";
import { getPreflightRun } from "../ledger/preflightStore.js";
import { runPreflight } from "./runner.js";

const SNAP = LEDGER_PATH + ".runner-test-snap";
const _had = existsSync(LEDGER_PATH);
if (_had) copyFileSync(LEDGER_PATH, SNAP);
function restore(): void {
  try { closeLedger(); } catch { /* */ }
  if (_had) { copyFileSync(SNAP, LEDGER_PATH); try { unlinkSync(SNAP); } catch { /* */ } }
  else if (existsSync(LEDGER_PATH)) { try { unlinkSync(LEDGER_PATH); } catch { /* */ } }
}
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(130); });

function assert(c: unknown, m: string): void {
  if (!c) { process.stderr.write(`FAIL  ${m}\n`); process.exitCode = 1; }
  else process.stdout.write(`PASS  ${m}\n`);
}

openLedger();

// ── env-fail → all downstream skip (no network: env fails first) ─────────

const saved = { ...process.env };
delete process.env["APPLE_TEAM_ID"]; // force env check to fail

const handle = runPreflight({ trigger: "manual", surface: "ui" });
const finalStatus = await handle.done;

process.env = saved; // restore env

const run = getPreflightRun(handle.id);
assert(run !== undefined, "runner: run row persisted");
assert(run?.checks.length === 10, `runner: all 10 checks recorded (got ${run?.checks.length})`);

const byName = new Map(run!.checks.map((c) => [c.name, c]));
assert(byName.get("env")?.status === "fail", `runner: env failed (got ${byName.get("env")?.status})`);
const downstream = run!.checks.filter((c) => c.name !== "env");
assert(downstream.every((c) => c.status === "skip"), "runner: all 9 downstream → skip when env fails");
assert(
  downstream.every((c) => JSON.parse(c.detail!).reason === "prerequisite env failed"),
  "runner: skip detail reason = 'prerequisite env failed'",
);
assert(finalStatus === "failed", `runner: env-fail → final status 'failed' (got ${finalStatus})`);

// env check detail reports the missing key
const envDetail = JSON.parse(byName.get("env")!.detail!);
assert(Array.isArray(envDetail.missing_keys) && envDetail.missing_keys.includes("APPLE_TEAM_ID"), "runner: env detail lists missing key");

// ── seq ordering is stable (env=1, spotify 2-5, apple 6-10) ──────────────

assert(byName.get("env")?.seq === 1, "runner: env seq=1");
assert(byName.get("spotify_token")?.seq === 2 && byName.get("spotify_search")?.seq === 5, "runner: spotify group seq 2-5");
assert(byName.get("apple_dev_token")?.seq === 6 && byName.get("apple_isrc_lookup")?.seq === 10, "runner: apple group seq 6-10");

process.exit(process.exitCode ?? 0);

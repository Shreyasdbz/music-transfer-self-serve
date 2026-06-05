// Unit tests for preflightStore — insertion, one-running conflict, latest,
// and the gate-state computation (24h soft expiry + invalidation-after-pass).
// Snapshot/restore the real ledger.

import { existsSync, copyFileSync, unlinkSync } from "node:fs";
import { LEDGER_PATH } from "../config.js";
import { closeLedger, openLedger } from "./db.js";
import {
  computeGateState,
  finishPreflightRun,
  getLatestPreflightRun,
  getPreflightRun,
  hasInvalidationSinceLastPass,
  insertInvalidation,
  insertPreflightCheck,
  insertPreflightRun,
  PreflightRunningConflict,
  GATE_TTL_MS,
} from "./preflightStore.js";

const SNAP = LEDGER_PATH + ".preflight-test-snap";
const _had = existsSync(LEDGER_PATH);
if (_had) copyFileSync(LEDGER_PATH, SNAP);
function restore(): void {
  try {
    closeLedger();
  } catch {
    /* */
  }
  if (_had) {
    copyFileSync(SNAP, LEDGER_PATH);
    try {
      unlinkSync(SNAP);
    } catch {
      /* */
    }
  } else if (existsSync(LEDGER_PATH)) {
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
// Clean any prior test rows.
db.prepare("DELETE FROM preflight_checks WHERE run_id LIKE 'pf-test-%'").run();
db.prepare("DELETE FROM preflight_runs WHERE id LIKE 'pf-test-%'").run();
// Also clear ALL rows so gate tests are deterministic (snapshot restores them).
db.prepare("DELETE FROM preflight_checks").run();
db.prepare("DELETE FROM preflight_runs").run();

const T0 = Date.parse("2026-06-04T00:00:00.000Z");

// ── insert + finish + read-back ──────────────────────────────────────────

insertPreflightRun({
  id: "pf-test-1",
  started_at: new Date(T0).toISOString(),
  status: "running",
  trigger: "manual",
  surface: "ui",
});
insertPreflightCheck({
  run_id: "pf-test-1",
  seq: 1,
  name: "env",
  status: "pass",
  detail: '{"missing_keys":[],"key_file_readable":true}',
  duration_ms: 3,
});
finishPreflightRun("pf-test-1", "passed", new Date(T0 + 1000).toISOString());

const r = getPreflightRun("pf-test-1");
assert(r?.status === "passed", `read-back: status passed (got ${r?.status})`);
assert(r?.checks.length === 1 && r.checks[0]?.name === "env", "read-back: check rows attached");
assert(r?.finished_at !== null, "read-back: finished_at set");

// ── one-running conflict ─────────────────────────────────────────────────

insertPreflightRun({
  id: "pf-test-run-a",
  started_at: new Date(T0 + 2000).toISOString(),
  status: "running",
  trigger: "manual",
  surface: "ui",
});
let conflict = false;
try {
  insertPreflightRun({
    id: "pf-test-run-b",
    started_at: new Date(T0 + 3000).toISOString(),
    status: "running",
    trigger: "manual",
    surface: "ui",
  });
} catch (e) {
  conflict = e instanceof PreflightRunningConflict;
}
assert(conflict, "one-running: second running insert → PreflightRunningConflict");
finishPreflightRun("pf-test-run-a", "failed", new Date(T0 + 4000).toISOString());

// ── latest ───────────────────────────────────────────────────────────────

const latest = getLatestPreflightRun();
assert(latest?.id === "pf-test-run-a", `latest: most recent by started_at (got ${latest?.id})`);

// ── gate: passed within 24h → open ───────────────────────────────────────

db.prepare("DELETE FROM preflight_runs").run();
const passAt = T0 + 10_000;
insertPreflightRun({
  id: "pf-test-pass",
  started_at: new Date(passAt).toISOString(),
  status: "running",
  trigger: "manual",
  surface: "ui",
});
finishPreflightRun("pf-test-pass", "passed", new Date(passAt).toISOString());

assert(computeGateState(passAt + 60_000).open, "gate: passed 1min ago → open");
assert(
  !computeGateState(passAt + GATE_TTL_MS + 1).open,
  "gate: passed >24h ago → closed (soft expiry)",
);
{
  const g = computeGateState(passAt + GATE_TTL_MS + 60 * 60 * 1000);
  assert(
    !g.open && /soft 24h expiry/.test(g.reason),
    `gate: expiry reason mentions soft expiry (got "${g.reason}")`,
  );
}

// ── gate: invalidation after pass → closed ───────────────────────────────

insertInvalidation("pf-test-inval", "auto-401", new Date(passAt + 5 * 60_000).toISOString());
{
  const g = computeGateState(passAt + 6 * 60_000);
  assert(!g.open, "gate: invalidated after pass → closed");
  assert(/auth failure/.test(g.reason), `gate: invalidation reason (got "${g.reason}")`);
}

// A NEW pass after the invalidation re-opens the gate.
const repassAt = passAt + 10 * 60_000;
insertPreflightRun({
  id: "pf-test-repass",
  started_at: new Date(repassAt).toISOString(),
  status: "running",
  trigger: "manual",
  surface: "ui",
});
finishPreflightRun("pf-test-repass", "passed", new Date(repassAt).toISOString());
assert(computeGateState(repassAt + 60_000).open, "gate: new pass after invalidation → re-open");

// scope-trigger reason
db.prepare("DELETE FROM preflight_runs").run();
insertPreflightRun({
  id: "pf-test-p2",
  started_at: new Date(passAt).toISOString(),
  status: "running",
  trigger: "manual",
  surface: "ui",
});
finishPreflightRun("pf-test-p2", "passed", new Date(passAt).toISOString());
insertInvalidation("pf-test-inval2", "auto-403-scope", new Date(passAt + 60_000).toISOString());
{
  const g = computeGateState(passAt + 2 * 60_000);
  assert(
    !g.open && /scope\/permission/.test(g.reason),
    `gate: scope invalidation reason (got "${g.reason}")`,
  );
}

// ── hasInvalidationSinceLastPass (debounce predicate) ────────────────────

db.prepare("DELETE FROM preflight_runs").run();
const pAt = T0 + 100_000;
insertPreflightRun({
  id: "pf-test-dq",
  started_at: new Date(pAt).toISOString(),
  status: "running",
  trigger: "manual",
  surface: "ui",
});
finishPreflightRun("pf-test-dq", "passed", new Date(pAt).toISOString());
assert(!hasInvalidationSinceLastPass(), "debounce: no invalidation after pass → false");
insertInvalidation("pf-test-dq-inval", "auto-401", new Date(pAt + 1000).toISOString());
assert(hasInvalidationSinceLastPass(), "debounce: invalidation after pass → true");
// A re-pass clears the predicate.
const rp = pAt + 5000;
insertPreflightRun({
  id: "pf-test-dq-rp",
  started_at: new Date(rp).toISOString(),
  status: "running",
  trigger: "manual",
  surface: "ui",
});
finishPreflightRun("pf-test-dq-rp", "passed", new Date(rp).toISOString());
assert(!hasInvalidationSinceLastPass(), "debounce: re-pass after invalidation → false again");

// ── gate boundary: invalidation at the SAME ms as the pass → closed (>=) ──

db.prepare("DELETE FROM preflight_runs").run();
const sameTs = new Date(T0 + 200_000).toISOString();
insertPreflightRun({
  id: "pf-test-bnd",
  started_at: sameTs,
  status: "running",
  trigger: "manual",
  surface: "ui",
});
finishPreflightRun("pf-test-bnd", "passed", sameTs);
insertInvalidation("pf-test-bnd-inval", "auto-401", sameTs); // same exact timestamp
{
  const g = computeGateState(Date.parse(sameTs) + 60_000);
  assert(!g.open, "gate boundary: invalidation at same ms as pass → closed (fail-safe >=)");
}

// ── gate: no runs at all → closed ────────────────────────────────────────

db.prepare("DELETE FROM preflight_runs").run();
{
  const g = computeGateState(T0);
  assert(!g.open && /No passing/.test(g.reason), `gate: empty → closed (got "${g.reason}")`);
}

process.exit(process.exitCode ?? 0);

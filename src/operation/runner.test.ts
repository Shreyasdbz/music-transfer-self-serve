// Phase 7 runner tests — all 7 ACs exercised with INJECTED FAKE deps, so ZERO
// real API calls / writes happen. Snapshot/restore the real ledger.

import { existsSync, copyFileSync, unlinkSync } from "node:fs";
import { LEDGER_PATH } from "../config.js";
import { closeLedger, openLedger } from "../ledger/db.js";
import { getOperation, getOperationEvents, OperationRunningConflict } from "../ledger/operationsStore.js";
import { __setOperationDeps, __resetOperationDeps, type DestTrack } from "./deps.js";
import { startOperation } from "./runner.js";
import type { CanonicalTrack } from "../match/identity.js";
import type { MatchResult } from "../match/matcher.js";
import type { OperationSpec } from "./types.js";

const SNAP = LEDGER_PATH + ".op-test-snap";
const _had = existsSync(LEDGER_PATH);
if (_had) copyFileSync(LEDGER_PATH, SNAP);
let restored = false;
function restore(): void {
  if (restored) return;
  restored = true;
  try { closeLedger(); } catch { /* */ }
  if (_had && existsSync(SNAP)) { copyFileSync(SNAP, LEDGER_PATH); try { unlinkSync(SNAP); } catch { /* */ } }
  else if (!_had && existsSync(LEDGER_PATH)) { try { unlinkSync(LEDGER_PATH); } catch { /* */ } }
}
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(130); });

function assert(c: unknown, m: string): void {
  if (!c) { process.stderr.write(`FAIL  ${m}\n`); process.exitCode = 1; }
  else process.stdout.write(`PASS  ${m}\n`);
}

const db = openLedger();
db.prepare("DELETE FROM operation_events").run();
db.prepare("DELETE FROM operations").run();

// ── Fixtures ──────────────────────────────────────────────────────────────

function srcTrack(n: number, isrc: string): CanonicalTrack {
  return { isrc, title: `Song ${n}`, primaryArtist: `Artist ${n}`, artists: [`Artist ${n}`], album: "Alb", durationMs: 200000, explicit: false, source: "spotify", sourceId: `sp${n}` };
}
function matchTo(destId: string, isrc: string): MatchResult {
  return { tier: "isrc", confidence: 100, fromCache: false, rejected: undefined, destination: { id: destId, isrc, canonical: { isrc, title: "x", primaryArtist: "y", artists: ["y"], album: undefined, durationMs: undefined, explicit: undefined, source: "apple", sourceId: destId } } };
}
// Each test uses a DISTINCT destination name → a distinct Operation tuple, so
// the §12.5 resume-union (which intentionally skips ids written by prior runs
// of the SAME tuple) doesn't bleed across independent test cases.
function spec(name: string, over: Partial<OperationSpec> = {}): OperationSpec {
  return { source: "spotify", destination: "apple", sourceTarget: { kind: "liked" }, destinationTarget: { kind: "create", name }, rematch: false, ...over };
}

// A configurable fake dep set per test.
function fakeDeps(opts: {
  source: CanonicalTrack[];
  dest?: DestTrack[];
  matchMap?: Record<string, string>; // sourceId → destId ("" = unmatched)
  writes: string[][]; // collects each writeTracks call's destIds
  failDestIds?: Set<string>; // throw on writing these (per-track)
  fail404DestIds?: Set<string>; // throw HttpError 404 on these → revalidation
  rematchSeen?: Set<string>; // records which source ids had deleteCache called
  createdId?: string;
}) {
  return {
    readSource: async () => opts.source,
    readDestination: async () => opts.dest ?? [],
    createDestination: async () => opts.createdId ?? "p.NEW",
    match: async (s: CanonicalTrack) => {
      const d = opts.matchMap?.[s.sourceId];
      if (d === undefined || d === "") return { tier: "unmatched", confidence: 0, fromCache: false, rejected: undefined, destination: undefined } as MatchResult;
      return matchTo(d, s.isrc ?? "X");
    },
    deleteCache: (s: CanonicalTrack) => { opts.rematchSeen?.add(s.sourceId); },
    writeTracks: async (_dst: unknown, _t: unknown, _pid: string | undefined, destIds: string[]) => {
      // Per-track fallback calls this with a single id; batch with many.
      for (const id of destIds) {
        if (opts.fail404DestIds?.has(id)) { const { HttpError } = await import("../util/http.js"); throw new HttpError(404, "gone", "x"); }
        if (opts.failDestIds?.has(id)) throw new Error("write boom");
      }
      opts.writes.push(destIds);
    },
  };
}

// ── AC #1: moves missing tracks; skips already-present ────────────────────
{
  const writes: string[][] = [];
  // 3 source tracks; one (sp2) already present in D by identity key.
  const present: DestTrack = { canonical: { ...srcTrack(2, "ISRC0002"), source: "apple", sourceId: "ap2" }, destId: "ap2" };
  __setOperationDeps(fakeDeps({
    source: [srcTrack(1, "ISRC0001"), srcTrack(2, "ISRC0002"), srcTrack(3, "ISRC0003")],
    dest: [present],
    matchMap: { sp1: "ap1", sp3: "ap3" },
    writes,
  }));
  const h = startOperation(spec("AC1 dest"));
  const status = await h.done;
  const op = getOperation(h.id);
  assert(status === "succeeded", `AC1: status succeeded (got ${status})`);
  assert(JSON.parse(op!.summary!).written === 2, `AC1: wrote 2 missing (got ${JSON.parse(op!.summary!).written})`);
  assert(JSON.parse(op!.summary!).skipped === 1, `AC1: skipped 1 already-present (got ${JSON.parse(op!.summary!).skipped})`);
  assert(writes.flat().sort().join(",") === "ap1,ap3", `AC1: wrote ap1,ap3 (got ${writes.flat()})`);
  __resetOperationDeps();
}

// ── AC #2: idempotent re-run writes zero ──────────────────────────────────
{
  const writes: string[][] = [];
  // D already contains all source tracks by identity.
  const dest: DestTrack[] = [1, 2, 3].map((n) => ({ canonical: { ...srcTrack(n, `ISRC000${n}`), source: "apple", sourceId: `ap${n}` }, destId: `ap${n}` }));
  __setOperationDeps(fakeDeps({ source: [1, 2, 3].map((n) => srcTrack(n, `ISRC000${n}`)), dest, matchMap: { sp1: "ap1", sp2: "ap2", sp3: "ap3" }, writes }));
  const h = startOperation(spec("AC2 dest"));
  await h.done;
  assert(writes.length === 0, `AC2: idempotent re-run wrote nothing (got ${writes.flat().length} writes)`);
  assert(JSON.parse(getOperation(h.id)!.summary!).written === 0, "AC2: summary written=0");
  __resetOperationDeps();
}

// ── AC #3: mid-run single-track failure recorded, operation continues ─────
{
  const writes: string[][] = [];
  __setOperationDeps(fakeDeps({
    source: [srcTrack(1, "ISRC0001"), srcTrack(2, "ISRC0002"), srcTrack(3, "ISRC0003")],
    matchMap: { sp1: "ap1", sp2: "apBAD", sp3: "ap3" },
    writes,
    failDestIds: new Set(["apBAD"]),
  }));
  const h = startOperation(spec("AC3 dest"));
  const status = await h.done;
  const sum = JSON.parse(getOperation(h.id)!.summary!);
  assert(sum.failed === 1, `AC3: one failed action (got ${sum.failed})`);
  assert(sum.written === 2, `AC3: other two written (got ${sum.written})`);
  assert(status === "partial", `AC3: partial status (got ${status})`);
  __resetOperationDeps();
}

// ── AC #5: rematch deletes cache + matches with from_cache:false ──────────
{
  const writes: string[][] = [];
  const rematchSeen = new Set<string>();
  __setOperationDeps(fakeDeps({ source: [srcTrack(1, "ISRC0001")], matchMap: { sp1: "ap1" }, writes, rematchSeen }));
  const h = startOperation(spec("AC5 dest", { rematch: true }));
  await h.done;
  assert(rematchSeen.has("sp1"), "AC5: rematch called deleteCache for source item");
  const events = getOperationEvents(h.id);
  const matchEvt = events.find((e) => e.type === "match");
  assert(matchEvt && JSON.parse(matchEvt.payload!).from_cache === false, "AC5: match event from_cache=false");
  __resetOperationDeps();
}

// ── AC #7: auto-revalidation on 404 → re-resolve + retry ──────────────────
{
  const writes: string[][] = [];
  let matchCalls = 0;
  __setOperationDeps({
    readSource: async () => [srcTrack(1, "ISRC0001")],
    readDestination: async () => [],
    createDestination: async () => "p.NEW",
    match: async (s: CanonicalTrack) => {
      matchCalls += 1;
      // First match → stale id ap404; revalidation match → fresh apOK.
      return matchTo(matchCalls === 1 ? "ap404" : "apOK", s.isrc ?? "X");
    },
    deleteCache: () => {},
    writeTracks: async (_d: unknown, _t: unknown, _p: string | undefined, ids: string[]) => {
      for (const id of ids) { if (id === "ap404") { const { HttpError } = await import("../util/http.js"); throw new HttpError(404, "gone", "x"); } }
      writes.push(ids);
    },
  });
  const h = startOperation(spec("AC7 dest"));
  await h.done;
  assert(writes.flat().includes("apOK"), `AC7: revalidated write landed apOK (got ${writes.flat()})`);
  const events = getOperationEvents(h.id);
  const reval = events.find((e) => e.type === "match" && JSON.parse(e.payload ?? "{}").revalidated === true);
  assert(reval !== undefined, "AC7: match event with revalidated:true");
  assert(JSON.parse(getOperation(h.id)!.summary!).written === 1, "AC7: written=1 after revalidation");
  __resetOperationDeps();
}

// ── one-running conflict ─────────────────────────────────────────────────
{
  // Leave a running row by inserting directly, then a startOperation must 409.
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO operations (id, created_at, finished_at, source, destination, source_target, destination_target, status, summary) VALUES ('op-running', ?, NULL, 'spotify','apple','{}','{}','running', NULL)`).run(now);
  let conflict = false;
  try {
    __setOperationDeps(fakeDeps({ source: [], writes: [] }));
    startOperation(spec("conflict dest"));
  } catch (e) { conflict = e instanceof OperationRunningConflict; }
  assert(conflict, "one-running: second startOperation → OperationRunningConflict");
  db.prepare("DELETE FROM operations WHERE id='op-running'").run();
  __resetOperationDeps();
}

// ── SSE replay surface: events persisted by seq, getOperationEvents(after) ─
{
  const writes: string[][] = [];
  __setOperationDeps(fakeDeps({ source: [srcTrack(1, "ISRC0001"), srcTrack(2, "ISRC0002")], matchMap: { sp1: "ap1", sp2: "ap2" }, writes }));
  const h = startOperation(spec("AC6 dest"));
  await h.done;
  const all = getOperationEvents(h.id);
  const after = getOperationEvents(h.id, all[2]!.seq);
  assert(all.length > 3, "AC6: events persisted with monotonic seq");
  assert(after.every((e) => e.seq > all[2]!.seq), "AC6: getOperationEvents(afterSeq) replays only seq > N");
  assert(all[all.length - 1]!.type === "done", "AC6: terminal event is 'done'");
  __resetOperationDeps();
}

process.exit(process.exitCode ?? 0);

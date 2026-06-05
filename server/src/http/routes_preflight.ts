// Preflight HTTP routes (blueprint §11.2) + the gated stubs that enforce the
// 412 precondition on Catalog refresh and Operations.
//
//   GET  /api/preflight/latest      latest run + checks (or null)
//   POST /api/preflight/run         start a run → { id }; 409 if one running
//   GET  /api/preflight/:id         a specific run + checks
//   GET  /api/preflight/:id/events  SSE: per-check live + replay (Last-Event-ID)
//   GET  /api/gate                  current gate state { open, reason }
//   POST /api/catalog/refresh       gated stub → 412 when closed (Phase 6 fills in)
//   POST /api/operations            gated stub → 412 when closed (Phase 7 fills in)

import type { ServerResponse } from "node:http";
import { route, sendJson, sendStatus } from "./server.js";
import { runPreflight, subscribePreflight, type CheckEvent } from "../preflight/runner.js";
import { getGateState } from "../preflight/gate.js";
import {
  getLatestPreflightRun,
  getPreflightRun,
  PreflightRunningConflict,
} from "../ledger/preflightStore.js";
import { log } from "../util/log.js";

function sseInit(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
  });
}

/** Write one SSE frame. `id` is the row's numeric `seq` per §11.2 so the
 * browser's Last-Event-ID reconnect protocol works; pass `null` for terminal
 * frames (e.g. `complete`) so we don't poison Last-Event-ID with a
 * non-numeric value (the stream closes right after, so no reconnect resumes
 * from it anyway). */
function sseSend(res: ServerResponse, id: number | null, event: string, data: unknown): void {
  const idLine = id === null ? "" : `id: ${id}\n`;
  res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerPreflightRoutes(): void {
  route("GET", "/api/gate", ({ res }) => {
    sendJson(res, 200, getGateState());
  });

  route("GET", "/api/preflight/latest", ({ res }) => {
    const run = getLatestPreflightRun();
    sendJson(res, 200, run ?? null);
  });

  route("POST", "/api/preflight/run", ({ res }) => {
    try {
      const handle = runPreflight({ trigger: "manual", surface: "ui" });
      // Fire-and-forget; the SSE stream and /latest reflect progress.
      void handle.done.catch(() => undefined);
      sendJson(res, 201, { id: handle.id });
    } catch (err) {
      if (err instanceof PreflightRunningConflict) {
        sendStatus(res, 409, "preflight_already_running");
        return;
      }
      log.error("preflight.run_route_failed", { message: (err as Error).message });
      sendStatus(res, 500, "preflight_start_failed");
    }
  });

  route("GET", "/api/preflight/:id", ({ res, params }) => {
    const run = getPreflightRun(params["id"]!);
    if (!run) {
      sendStatus(res, 404, "preflight_run_not_found");
      return;
    }
    sendJson(res, 200, run);
  });

  route("GET", "/api/preflight/:id/events", ({ req, res, params }) => {
    const id = params["id"]!;
    const run = getPreflightRun(id);
    if (!run) {
      sendStatus(res, 404, "preflight_run_not_found");
      return;
    }

    const lastEventId = Number(req.headers["last-event-id"] ?? 0) || 0;
    const sentSeqs = new Set<number>();

    sseInit(res);

    const emitter = subscribePreflight(id);
    let closed = false;

    const writeCheck = (evt: CheckEvent): void => {
      if (closed || evt.seq <= lastEventId || sentSeqs.has(evt.seq)) return;
      sentSeqs.add(evt.seq);
      sseSend(res, evt.seq, "check", evt);
    };
    const complete = (payload: unknown): void => {
      if (closed) return;
      sseSend(res, null, "complete", payload);
      closed = true;
      res.end();
    };

    // Live subscription (if the run is still in flight).
    if (emitter) {
      emitter.on("check", writeCheck);
      emitter.on("complete", complete);
    }

    // Replay any already-persisted checks (seq > Last-Event-ID). Synchronous
    // (better-sqlite3) so no live event can interleave before this finishes.
    const fresh = getPreflightRun(id);
    for (const c of fresh?.checks ?? []) {
      if (c.seq > lastEventId && !sentSeqs.has(c.seq)) {
        sentSeqs.add(c.seq);
        sseSend(res, c.seq, "check", {
          seq: c.seq,
          name: c.name,
          status: c.status,
          detail: c.detail ? JSON.parse(c.detail) : {},
          duration_ms: c.duration_ms ?? 0,
        });
      }
    }

    // If the run already finished, emit the terminal event and close.
    if (fresh && fresh.status !== "running") {
      complete({ id, status: fresh.status, finished_at: fresh.finished_at });
    }

    req.on("close", () => {
      closed = true;
      if (emitter) {
        emitter.off("check", writeCheck);
        emitter.off("complete", complete);
      }
    });
  });

  // Catalog refresh + Operations routes live in routes_catalog.ts /
  // routes_operations.ts (Phase 6) — they share the gate guard below.
}

/** Shared gate guard for the gated POST routes (§11.1). Returns true and
 * sends a 412 with the contextual reason when the gate is closed; the caller
 * should return early. */
export function gateClosed(res: ServerResponse): boolean {
  const gate = getGateState();
  if (!gate.open) {
    sendJson(res, 412, { error: "gate_closed", reason: gate.reason });
    return true;
  }
  return false;
}

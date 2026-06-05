// Preflight HTTP routes (blueprint §11.2) + the shared gate guard (Hono).
//   GET  /api/gate                  current gate state { open, reason }
//   GET  /api/preflight/latest      latest run + checks (or null)
//   POST /api/preflight/run         start a run → { id }; 409 if one running
//   GET  /api/preflight/:id         a specific run + checks
//   GET  /api/preflight/:id/events  SSE: per-check live + replay (Last-Event-ID)

import type { Context, Hono } from "hono";
import { err } from "./respond.js";
import { sse } from "./sse.js";
import { runPreflight, subscribePreflight, type CheckEvent } from "../preflight/runner.js";
import { getGateState } from "../preflight/gate.js";
import {
  getLatestPreflightRun,
  getPreflightRun,
  PreflightRunningConflict,
} from "../ledger/preflightStore.js";
import { log } from "../util/log.js";

export function registerPreflightRoutes(app: Hono): void {
  app.get("/api/gate", (c) => c.json(getGateState()));

  app.get("/api/preflight/latest", (c) => c.json(getLatestPreflightRun() ?? null));

  app.post("/api/preflight/run", (c) => {
    try {
      const handle = runPreflight({ trigger: "manual", surface: "ui" });
      void handle.done.catch(() => undefined); // fire-and-forget; SSE + /latest reflect progress
      return c.json({ id: handle.id }, 201);
    } catch (e) {
      if (e instanceof PreflightRunningConflict) return err(c, 409, "preflight_already_running");
      log.error("preflight.run_route_failed", { message: (e as Error).message });
      return err(c, 500, "preflight_start_failed");
    }
  });

  app.get("/api/preflight/:id", (c) => {
    const run = getPreflightRun(c.req.param("id"));
    if (!run) return err(c, 404, "preflight_run_not_found");
    return c.json(run);
  });

  app.get("/api/preflight/:id/events", (c) => {
    const id = c.req.param("id");
    const run = getPreflightRun(id);
    if (!run) return err(c, 404, "preflight_run_not_found");

    const lastEventId = Number(c.req.header("last-event-id") ?? 0) || 0;
    return sse(c, (api) => {
      const sentSeqs = new Set<number>();
      const writeCheck = (evt: CheckEvent): void => {
        if (evt.seq <= lastEventId || sentSeqs.has(evt.seq)) return;
        sentSeqs.add(evt.seq);
        api.write({ id: String(evt.seq), event: "check", data: JSON.stringify(evt) });
      };
      const complete = (payload: unknown): void => {
        api.write({ event: "complete", data: JSON.stringify(payload) }); // no id line (terminal)
        api.done();
      };

      const emitter = subscribePreflight(id);
      if (emitter) {
        emitter.on("check", writeCheck);
        emitter.on("complete", complete);
        api.onClose(() => {
          emitter.off("check", writeCheck);
          emitter.off("complete", complete);
        });
      }

      // Replay already-persisted checks (seq > Last-Event-ID); synchronous, so
      // no live event interleaves before this finishes.
      const fresh = getPreflightRun(id);
      for (const ck of fresh?.checks ?? []) {
        if (ck.seq > lastEventId && !sentSeqs.has(ck.seq)) {
          sentSeqs.add(ck.seq);
          api.write({
            id: String(ck.seq),
            event: "check",
            data: JSON.stringify({
              seq: ck.seq,
              name: ck.name,
              status: ck.status,
              detail: ck.detail ? JSON.parse(ck.detail) : {},
              duration_ms: ck.duration_ms ?? 0,
            }),
          });
        }
      }

      if (fresh && fresh.status !== "running") {
        complete({ id, status: fresh.status, finished_at: fresh.finished_at });
      }
    });
  });
}

/** Shared gate guard for the gated POST routes (§11.1). Returns a 412 Response
 * (with the contextual reason) when the gate is closed, else null; the caller
 * does `const blocked = gateBlocked(c); if (blocked) return blocked;`. */
export function gateBlocked(c: Context): Response | null {
  const gate = getGateState();
  if (!gate.open) return c.json({ error: "gate_closed", reason: gate.reason }, 412);
  return null;
}

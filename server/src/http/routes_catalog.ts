// Catalog HTTP routes (blueprint §11.2), Hono.
//   GET  /api/catalog                cached catalog, both platforms
//   POST /api/catalog/refresh        gated; start an incremental refresh → 202
//   POST /api/catalog/refresh/cancel cancel in-flight; keep written rows
//   GET  /api/catalog/events         SSE: per-platform per-playlist progress

import type { Hono } from "hono";
import { err } from "./respond.js";
import { sse } from "./sse.js";
import { gateBlocked } from "./routes_preflight.js";
import {
  cancelCatalogRefresh,
  isCatalogRefreshRunning,
  startCatalogRefresh,
  subscribeCatalog,
  CatalogRefreshRunningError,
  type CatalogEvent,
} from "../catalog/catalog.js";
import { getCatalog, lastFetchedAt } from "../ledger/catalogStore.js";
import { log } from "../util/log.js";

export function registerCatalogRoutes(app: Hono): void {
  app.get("/api/catalog", (c) =>
    c.json({
      rows: getCatalog(),
      last_fetched: { spotify: lastFetchedAt("spotify"), apple: lastFetchedAt("apple") },
      refreshing: isCatalogRefreshRunning(),
    }),
  );

  app.post("/api/catalog/refresh", (c) => {
    const blocked = gateBlocked(c);
    if (blocked) return blocked;
    try {
      const handle = startCatalogRefresh();
      void handle.done.catch(() => undefined);
      return c.json({ started: true }, 202);
    } catch (e) {
      if (e instanceof CatalogRefreshRunningError) return err(c, 409, "catalog_refresh_already_running");
      log.error("catalog.refresh_route_failed", { message: (e as Error).message });
      return err(c, 500, "catalog_refresh_failed");
    }
  });

  app.post("/api/catalog/refresh/cancel", (c) => c.json({ cancelled: cancelCatalogRefresh() }));

  app.get("/api/catalog/events", (c) =>
    sse(c, (api) => {
      // No `id:` line: catalog progress is transient (seq resets each refresh —
      // a non-monotonic id would poison the browser's Last-Event-ID). Purely
      // live; a reconnecting client just follows the current refresh.
      const emitter = subscribeCatalog();
      const onEvent = (evt: CatalogEvent): void => {
        api.write({ event: evt.type, data: JSON.stringify(evt) });
        if (evt.type === "complete" || evt.type === "cancelled") api.done();
      };
      emitter.on("event", onEvent);
      api.onClose(() => emitter.off("event", onEvent));

      // If no refresh is running, tell the client immediately so it doesn't hang.
      if (!isCatalogRefreshRunning()) {
        api.write({ event: "idle", data: JSON.stringify({ type: "idle" }) });
      }
    }),
  );
}

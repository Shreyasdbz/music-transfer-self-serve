// Catalog HTTP routes (blueprint §11.2):
//   GET  /api/catalog               cached catalog, both platforms
//   POST /api/catalog/refresh       gated; start an incremental refresh → 202
//   POST /api/catalog/refresh/cancel cancel in-flight; keep written rows
//   GET  /api/catalog/events        SSE: per-platform per-playlist progress

import type { ServerResponse } from "node:http";
import { route, sendJson, sendStatus } from "./server.js";
import { gateClosed } from "./routes_preflight.js";
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

function sseInit(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
  });
}

export function registerCatalogRoutes(): void {
  route("GET", "/api/catalog", ({ res }) => {
    sendJson(res, 200, {
      rows: getCatalog(),
      last_fetched: { spotify: lastFetchedAt("spotify"), apple: lastFetchedAt("apple") },
      refreshing: isCatalogRefreshRunning(),
    });
  });

  route("POST", "/api/catalog/refresh", ({ res }) => {
    if (gateClosed(res)) return;
    try {
      const handle = startCatalogRefresh();
      void handle.done.catch(() => undefined);
      sendJson(res, 202, { started: true });
    } catch (err) {
      if (err instanceof CatalogRefreshRunningError) {
        sendStatus(res, 409, "catalog_refresh_already_running");
        return;
      }
      log.error("catalog.refresh_route_failed", { message: (err as Error).message });
      sendStatus(res, 500, "catalog_refresh_failed");
    }
  });

  route("POST", "/api/catalog/refresh/cancel", ({ res }) => {
    const cancelled = cancelCatalogRefresh();
    sendJson(res, 200, { cancelled });
  });

  route("GET", "/api/catalog/events", ({ req, res }) => {
    sseInit(res);
    const emitter = subscribeCatalog();
    let closed = false;

    // No `id:` line: catalog progress is transient (no replay store, and the
    // seq counter resets each refresh — a non-monotonic id would poison the
    // browser's Last-Event-ID on reconnect). The stream is purely live; a
    // reconnecting client just starts following the current refresh.
    const onEvent = (evt: CatalogEvent): void => {
      if (closed) return;
      res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      if (evt.type === "complete" || evt.type === "cancelled") {
        closed = true;
        emitter.off("event", onEvent);
        res.end();
      }
    };
    emitter.on("event", onEvent);

    // If no refresh is running, tell the client immediately so it doesn't hang.
    if (!isCatalogRefreshRunning()) {
      res.write(`event: idle\ndata: {"type":"idle"}\n\n`);
    }

    req.on("close", () => {
      closed = true;
      emitter.off("event", onEvent);
    });
  });
}

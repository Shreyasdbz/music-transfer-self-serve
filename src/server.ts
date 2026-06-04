// Entrypoint — opens the ledger, runs the startup sweep, starts the HTTP
// server. Phase 1 surface: GET /api/health + static web/ + §11.0 security
// framework. Subsequent phases register additional routes via the
// `route()` helper in `http/server.ts`.

import { closeLedger, openLedger } from "./ledger/db.js";
import { startHttpServer } from "./http/server.js";
import { registerAuthRoutes } from "./http/routes_auth.js";
import { registerPreflightRoutes } from "./http/routes_preflight.js";
import { registerCatalogRoutes } from "./http/routes_catalog.js";
import { registerOperationsRoutes } from "./http/routes_operations.js";
import { installAuthFailureSink } from "./preflight/gate.js";
import { stopStateSweeper } from "./auth/spotify.js";
import { stopNonceSweeper } from "./auth/apple.js";
import { log } from "./util/log.js";

async function main(): Promise<void> {
  openLedger();
  installAuthFailureSink(); // wire util/http 401/403-scope → gate auto-invalidation
  registerAuthRoutes();
  registerPreflightRoutes();
  registerCatalogRoutes();
  registerOperationsRoutes();
  const handle = await startHttpServer();

  const shutdown = (signal: string): void => {
    log.info("server.shutdown", { signal });
    stopStateSweeper();
    stopNonceSweeper();
    void handle.close().finally(() => {
      closeLedger();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("server.bootstrap_failed", { message: (err as Error).message });
  process.exit(1);
});

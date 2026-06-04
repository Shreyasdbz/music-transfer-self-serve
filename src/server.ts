// Entrypoint — opens the ledger, runs the startup sweep, starts the HTTP
// server. Phase 1 surface: GET /api/health + static web/ + §11.0 security
// framework. Subsequent phases register additional routes via the
// `route()` helper in `http/server.ts`.

import { closeLedger, openLedger } from "./ledger/db.js";
import { startHttpServer } from "./http/server.js";
import { registerAuthRoutes } from "./http/routes_auth.js";
import { stopStateSweeper } from "./auth/spotify.js";
import { log } from "./util/log.js";

async function main(): Promise<void> {
  openLedger();
  registerAuthRoutes();
  const handle = await startHttpServer();

  const shutdown = (signal: string): void => {
    log.info("server.shutdown", { signal });
    stopStateSweeper();
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

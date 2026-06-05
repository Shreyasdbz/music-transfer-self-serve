// Entrypoint — opens the ledger, runs the startup sweep, starts the HTTP
// server. Phase 1 surface: GET /api/health + static web/ + §11.0 security
// framework. Subsequent phases register additional routes via the
// `route()` helper in `http/server.ts`.

import { closeLedger, openLedger } from "./ledger/db.js";
import { ensureEnvPerms, ENV_PATH } from "./config.js";
import { startHttpServer } from "./http/server.js";
import { registerBuiltInProviders } from "./providers/index.js";
import { installAuthFailureSink } from "./preflight/gate.js";
import { stopStateSweeper } from "./auth/spotify.js";
import { stopNonceSweeper } from "./auth/apple.js";
import { log } from "./util/log.js";

async function main(): Promise<void> {
  // Harden local .env perms before anything else (it holds secrets).
  const envPerms = ensureEnvPerms();
  if (envPerms === "tightened") log.info("env.perms_tightened", { path: ENV_PATH });
  else if (envPerms === "insecure") log.warn("env.perms_insecure", { path: ENV_PATH });

  openLedger();
  registerBuiltInProviders(); // register Spotify + Apple in the provider registry
  installAuthFailureSink(); // wire util/http 401/403-scope → gate auto-invalidation
  // startHttpServer() builds the Hono app and registers every route module
  // (auth/preflight/catalog/operations) + the §11.0 security middleware.
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

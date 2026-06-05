// HTTP server entry (Hono on @hono/node-server). Generates the per-server-start
// CSRF token, builds the app (security middleware + all routes), and listens on
// the configured host/port. Keeps the v1 `startHttpServer()` / `ServerHandle`
// shape so callers and tests are unaffected by the framework swap.

import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { HTTP_HOST, HTTP_ORIGIN, HTTP_PORT } from "../config.js";
import { log } from "../util/log.js";
import { buildApp } from "./app.js";
import { registerBuiltInProviders } from "../providers/index.js";

export interface ServerHandle {
  readonly server: Server;
  readonly csrfToken: string;
  close: () => Promise<void>;
}

export function startHttpServer(): Promise<ServerHandle> {
  // Ensure the provider registry is populated — /api/providers, the operations
  // route, and the runner all resolve providers from it. Idempotent (guarded),
  // so it's safe even though main() also calls it.
  registerBuiltInProviders();
  const csrfToken = randomBytes(32).toString("base64url");
  const app = buildApp(csrfToken);

  return new Promise<ServerHandle>((resolvePromise, rejectPromise) => {
    const server = serve(
      { fetch: app.fetch, hostname: HTTP_HOST, port: HTTP_PORT },
      (info) => {
        log.info("http.listening", { origin: HTTP_ORIGIN, port: info.port });
        resolvePromise({
          server: server as Server,
          csrfToken,
          close: () =>
            new Promise<void>((r, j) => {
              // Force-close lingering sockets (e.g. open SSE streams) so close()
              // resolves promptly instead of waiting on keep-alive connections —
              // otherwise a graceful shutdown (or a test) hangs on an active
              // event stream. Node ≥18.2.
              (server as Server).closeAllConnections?.();
              (server as Server).close((e) => (e ? j(e) : r()));
            }),
        });
      },
    ) as Server;

    server.on("error", (e: Error) => {
      log.error("http.listen_error", { message: e.message });
      rejectPromise(e);
    });
  });
}

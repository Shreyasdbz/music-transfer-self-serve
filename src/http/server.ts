// HTTP server skeleton per blueprint §11.0 + §11.2 (Phase 1 surface).
//
// Phase 1 wires:
//   - 127.0.0.1:8888 bind, fail loudly on EADDRINUSE / EACCES
//   - Per-server-start CSRF token (32 bytes base64url), injected into served HTML
//   - Middleware: Host check on every route; Origin + X-CSRF-Token check on POSTs
//   - GET /api/health (the liveness route + the AC fixture)
//   - Static handler for web/
//
// Phase 2+ routes plug into the same dispatcher (auth, preflight, catalog,
// operations, SSE). The Host/Origin/CSRF middleware applies to all of them.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { HTTP_HOST, HTTP_HOST_HEADER, HTTP_ORIGIN, HTTP_PORT } from "../config.js";
import { log } from "../util/log.js";
import { serveStatic } from "./static.js";

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly csrfToken: string;
}

type Handler = (ctx: RouteContext) => void | Promise<void>;
type Method = "GET" | "POST";

const routes: { method: Method; path: string; handler: Handler }[] = [];

export function route(method: Method, path: string, handler: Handler): void {
  routes.push({ method, path, handler });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function sendStatus(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

function hostHeaderOk(req: IncomingMessage): boolean {
  const host = req.headers["host"];
  return host === HTTP_HOST_HEADER;
}

function originOk(req: IncomingMessage): boolean {
  const origin = req.headers["origin"];
  if (typeof origin !== "string") return false;
  return origin === HTTP_ORIGIN;
}

function csrfOk(req: IncomingMessage, expected: string): boolean {
  const token = req.headers["x-csrf-token"];
  return typeof token === "string" && token === expected;
}

// Routes whose paths are exempted from the Origin check. Spotify's OAuth
// redirect is a top-level GET navigation with no Origin header — the route
// handler validates `state` instead (Phase 2).
const ORIGIN_EXEMPT_GET_PATHS = new Set<string>(["/auth/spotify/callback"]);

export interface ServerHandle {
  readonly server: Server;
  readonly csrfToken: string;
  close: () => Promise<void>;
}

export function startHttpServer(): Promise<ServerHandle> {
  const csrfToken = generateCsrfToken();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // 1) Host check — applies to every route, including GETs (DNS rebinding).
      if (!hostHeaderOk(req)) {
        sendStatus(res, 403, "host_header_invalid");
        return;
      }

      const url = new URL(req.url ?? "/", HTTP_ORIGIN);
      const method = req.method as Method;

      // 2) Origin + CSRF check — applies to every state-changing request.
      if (method === "POST") {
        const exempt = ORIGIN_EXEMPT_GET_PATHS.has(url.pathname); // none today, but symmetric
        if (!exempt && !originOk(req)) {
          sendStatus(res, 403, "origin_invalid");
          return;
        }
        if (!csrfOk(req, csrfToken)) {
          sendStatus(res, 403, "csrf_token_invalid");
          return;
        }
      }

      // 3) Route dispatch.
      const match = routes.find((r) => r.method === method && r.path === url.pathname);
      if (match) {
        await match.handler({ req, res, url, csrfToken });
        return;
      }

      // 4) Static fallback (GET only).
      if (method === "GET" && serveStatic(req, res, csrfToken)) return;

      sendStatus(res, 404, "not_found");
    } catch (err) {
      log.error("http.unhandled_error", { message: (err as Error).message });
      if (!res.headersSent) sendStatus(res, 500, "internal_error");
      else res.end();
    }
  };

  // Default route: GET /api/health.
  route("GET", "/api/health", ({ res }) => {
    sendJson(res, 200, { ok: true });
  });
  // POST /api/health exists only as a Phase 1 AC fixture for verifying that the
  // CSRF + Origin middleware actually fires.
  route("POST", "/api/health", ({ res }) => {
    sendJson(res, 200, { ok: true, method: "post" });
  });

  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer(handler);
    server.on("error", (err) => {
      log.error("http.listen_error", { message: (err as Error).message });
      rejectPromise(err);
    });
    server.listen(HTTP_PORT, HTTP_HOST, () => {
      log.info("http.listening", { origin: HTTP_ORIGIN });
      resolvePromise({
        server,
        csrfToken,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

export { sendJson, sendStatus };

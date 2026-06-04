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
  /** Path params captured from `:name` segments in the registered path. */
  readonly params: Record<string, string>;
}

type Handler = (ctx: RouteContext) => void | Promise<void>;
type Method = "GET" | "POST";

interface CompiledRoute {
  method: Method;
  segments: string[]; // literal segment or ":name"
  handler: Handler;
}

const routes: CompiledRoute[] = [];

export function route(method: Method, path: string, handler: Handler): void {
  routes.push({ method, segments: path.split("/").filter((s) => s.length > 0), handler });
}

/** Match a request pathname against a compiled route, returning captured
 * params or undefined on no match. */
function matchRoute(r: CompiledRoute, pathname: string): Record<string, string> | undefined {
  const parts = pathname.split("/").filter((s) => s.length > 0);
  if (parts.length !== r.segments.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < r.segments.length; i++) {
    const seg = r.segments[i]!;
    const part = parts[i]!;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(part);
    else if (seg !== part) return undefined;
  }
  return params;
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

// Read the full request body as a Buffer, capped to defend against runaway
// uploads. Local-only server, single user, no big bodies expected.
const BODY_BYTE_LIMIT = 1 << 20; // 1 MiB

/** Thrown on body-size overrun so the request handler can map to a 413
 * response. Other errors bubble as 500 via the global try/catch. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("body_too_large");
    this.name = "BodyTooLargeError";
  }
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overrun = false;
    req.on("data", (chunk: Buffer) => {
      if (overrun) return; // already past the cap; drop remaining chunks
      total += chunk.length;
      if (total > BODY_BYTE_LIMIT) {
        overrun = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      // Wait for the full request body before signalling the failure — this
      // lets the response 413 propagate cleanly instead of the socket being
      // torn down mid-upload (which surfaces as ECONNRESET on the client).
      if (overrun) rejectPromise(new BodyTooLargeError());
      else resolvePromise(Buffer.concat(chunks));
    });
    req.on("error", rejectPromise);
  });
}

export async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const buf = await readBody(req);
  if (buf.length === 0) return {} as T;
  return JSON.parse(buf.toString("utf8")) as T;
}

/** HTML-escape the five characters that matter for attribute / text contexts.
 * Used by {@link sendAutoCloseHtml} so callers can't accidentally inject
 * markup through the `message` parameter. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Serve a tiny HTML page that closes its own window — used by both OAuth
 * callbacks. `message` is HTML-escaped; callers should pass FIXED strings
 * (never user-controlled query params — log those server-side instead).
 *
 * Defense-in-depth: a strict CSP blocks any external script load and limits
 * inline JS to the small bootstrap below. The Spotify OAuth `error` query
 * param was previously echoed here unescaped, which gave any cross-origin
 * `<a href="http://127.0.0.1:8888/auth/spotify/callback?error=<script>…">`
 * top-level navigation a path to script execution inside the trusted local
 * origin. Now: escape + don't echo. */
export function sendAutoCloseHtml(res: ServerResponse, message: string): void {
  const safe = escapeHtml(message);
  const html = `<!doctype html><meta charset="utf-8"><title>${safe}</title>
<style>body{font-family:-apple-system,sans-serif;padding:2rem;color:#222}</style>
<p>${safe}</p><p>You can close this window.</p>
<script>setTimeout(()=>{try{window.close()}catch(_){}}, 250);</script>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(html);
}

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

      // 2) Origin + CSRF check — applies to every state-changing (POST)
      // request. GET routes are not gated because cross-origin reads are
      // already blocked by the browser; the Spotify OAuth redirect callback
      // is a GET top-level navigation (no Origin header) and validates
      // `state` inside the route handler instead (§11.0).
      if (method === "POST") {
        if (!originOk(req)) {
          sendStatus(res, 403, "origin_invalid");
          return;
        }
        if (!csrfOk(req, csrfToken)) {
          sendStatus(res, 403, "csrf_token_invalid");
          return;
        }
      }

      // 3) Route dispatch (with `:param` support).
      for (const r of routes) {
        if (r.method !== method) continue;
        const params = matchRoute(r, url.pathname);
        if (params) {
          await r.handler({ req, res, url, csrfToken, params });
          return;
        }
      }

      // 4) Static fallback (GET only).
      if (method === "GET" && serveStatic(req, res, csrfToken)) return;

      sendStatus(res, 404, "not_found");
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        if (!res.headersSent) sendStatus(res, 413, "body_too_large");
        else res.end();
        return;
      }
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

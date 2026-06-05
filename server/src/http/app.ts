// Builds the Hono app: §11.0 security middleware (Host/Origin/CSRF + body cap),
// the health fixtures, every route module, and the static fallback. The
// node:http server (server.ts) serves this via @hono/node-server.

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ALLOWED_HOSTS, ALLOWED_ORIGINS } from "../config.js";
import { listProviders } from "../providers/registry.js";
import { err } from "./respond.js";
import { serveStaticFile } from "./static.js";
import { registerSessionRoutes, sessionGate } from "./session.js";
import { registerAuthRoutes } from "./routes_auth.js";
import { registerPreflightRoutes } from "./routes_preflight.js";
import { registerCatalogRoutes } from "./routes_catalog.js";
import { registerOperationsRoutes } from "./routes_operations.js";

const BODY_BYTE_LIMIT = 1 << 20; // 1 MiB

/** Constant-time CSRF token compare (length-checked first; timingSafeEqual
 * throws on length mismatch). Mirrors session.ts `tokenOk`. */
function csrfOk(submitted: string | undefined, expected: string): boolean {
  if (!submitted || submitted.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
}

/** Build the Hono app bound to a specific per-server-start CSRF token. */
export function buildApp(csrfToken: string): Hono {
  const app = new Hono();

  // 0) Harden every JSON response to match v1 `sendJson`: Hono's c.json sets a
  // bare `application/json` Content-Type and nothing else, dropping the v1
  // `; charset=utf-8`, `Cache-Control: no-store`, and the §11.0
  // `X-Content-Type-Options: nosniff` header. Re-add them here (outermost, so it
  // also covers the security-middleware error responses below). Non-JSON paths
  // (static, the OAuth auto-close HTML, SSE) set their own headers and are skipped.
  app.use("*", async (c, next) => {
    await next();
    const ct = c.res.headers.get("content-type");
    if (ct && ct.startsWith("application/json")) {
      const headers = new Headers(c.res.headers);
      headers.set("Content-Type", "application/json; charset=utf-8");
      headers.set("Cache-Control", "no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      c.res = new Response(c.res.body, { status: c.res.status, headers });
    }
  });

  // 1) Host check on EVERY route (DNS-rebinding defense), then Origin + CSRF on
  // every state-changing POST. GET routes aren't Origin-gated (cross-origin
  // reads are browser-blocked; the Spotify OAuth callback is a GET top-level
  // navigation with no Origin and validates `state` in its handler).
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (!host || !ALLOWED_HOSTS.includes(host)) return err(c, 403, "host_header_invalid");
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      if (!origin || !ALLOWED_ORIGINS.includes(origin)) return err(c, 403, "origin_invalid");
      if (!csrfOk(c.req.header("x-csrf-token"), csrfToken)) return err(c, 403, "csrf_token_invalid");
    }
    await next();
  });

  // 2) Body size cap → 413 (replaces the v1 BodyTooLargeError path).
  app.use("*", bodyLimit({ maxSize: BODY_BYTE_LIMIT, onError: (c) => err(c, 413, "body_too_large") }));

  // 2.5) Access seam (§15 A3): gate /api/* on a valid session when
  // INSTANCE_ACCESS_TOKEN is set; a no-op for a local single-owner instance.
  sessionGate(app);

  // 3) Health (Phase 1 AC fixtures: liveness + CSRF/Origin enforcement check).
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.post("/api/health", (c) => c.json({ ok: true, method: "post" }));

  // CSRF token endpoint — lets the SPA read the per-server-start token in DEV,
  // where Vite (not Hono) serves index.html so the <meta> injection isn't there.
  // Same-origin only (no CORS headers), so a cross-origin page can't read it.
  app.get("/api/csrf", (c) => c.json({ csrfToken }));

  // Registry-driven provider list, so the UI's dropdowns/rows aren't hardcoded
  // (YouTube appears automatically once its provider registers in V7).
  app.get("/api/providers", (c) =>
    c.json({
      providers: listProviders().map((p) => ({
        id: p.id,
        displayName: p.displayName,
        likedKind: p.capabilities.likedKind,
        supportsIsrc: p.capabilities.supportsIsrc,
        likedReadable: p.capabilities.likedReadable,
        available: p.available ?? true,
      })),
    }),
  );

  // 4) Route modules.
  registerSessionRoutes(app);
  registerAuthRoutes(app);
  registerPreflightRoutes(app);
  registerCatalogRoutes(app);
  registerOperationsRoutes(app);

  // 5) Static fallback (GET only) → file or 404.
  app.get("*", (c) => {
    const pathname = new URL(c.req.url).pathname;
    return serveStaticFile(pathname, csrfToken) ?? err(c, 404, "not_found");
  });

  // Unmatched (non-GET, or no route) → JSON 404 (same shape as v1).
  app.notFound((c) => err(c, 404, "not_found"));

  return app;
}

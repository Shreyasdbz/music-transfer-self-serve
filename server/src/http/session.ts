// Access seam (blueprint §15 A3). When INSTANCE_ACCESS_TOKEN is set (network
// deploy), the instance requires a signed session cookie obtained by submitting
// the token once. When unset (default, local single-owner), access is open
// (loopback is the protection) and the user is always __owner__.
//
// The cookie is the ONLY browser-visible server value besides the CSRF token:
// HMAC-signed, HttpOnly, Secure, SameSite=Strict, carrying only { userId }.
// CSRF (double-submit) is retained alongside it. userId is __owner__ today; the
// shape is the seam for genuine multi-user later (no engine threads it yet).

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { INSTANCE_ACCESS_TOKEN, PUBLIC_ORIGIN, SESSION_SECRET } from "../config.js";
import { err } from "./respond.js";

const COOKIE = "mtss_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
export const OWNER_ID = "__owner__";
// Mark the cookie Secure only when the instance is actually served over HTTPS
// (the externally-visible scheme is encoded in PUBLIC_ORIGIN). A hardcoded
// `secure:true` would make access-controlled HTTP/loopback instances
// un-loginable — browsers silently drop a Secure cookie on an http:// origin.
const COOKIE_SECURE = PUBLIC_ORIGIN.startsWith("https://");
const COOKIE_OPTS = { httpOnly: true, secure: COOKIE_SECURE, sameSite: "Strict", path: "/" } as const;

interface Session {
  userId: string;
  iat: number;
}

export function accessControlEnabled(): boolean {
  return INSTANCE_ACCESS_TOKEN.length > 0;
}

function sign(payload: string): string {
  return createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

/** `<base64url(JSON{userId,iat})>.<base64url(HMAC)>` */
export function makeSessionCookie(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ userId, iat: Date.now() } satisfies Session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifySessionCookie(value: string | undefined): Session | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = sign(payload);
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    return typeof s.userId === "string" ? s : null;
  } catch {
    return null;
  }
}

/** Constant-time access-token check (lengths compared first to avoid throw). */
function tokenOk(token: string): boolean {
  if (token.length === 0 || token.length !== INSTANCE_ACCESS_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(INSTANCE_ACCESS_TOKEN));
}

/** Resolve the request's userId: OWNER when access control is off, else the
 * cookie's userId, or null when unauthenticated. */
export function sessionUser(c: Context): string | null {
  if (!accessControlEnabled()) return OWNER_ID;
  return verifySessionCookie(getCookie(c, COOKIE))?.userId ?? null;
}

const EXEMPT = new Set(["/api/session", "/api/health", "/api/csrf"]);

/** Gate every /api/* route on a valid session when access control is on. The
 * SPA can still load (static is not under /api) + GET /api/session, /api/csrf,
 * /api/health pre-login. */
export function sessionGate(app: Hono): void {
  app.use("/api/*", async (c, next) => {
    if (!accessControlEnabled()) return next();
    const pathname = new URL(c.req.url).pathname;
    if (EXEMPT.has(pathname)) return next();
    if (sessionUser(c) === null) return err(c, 401, "unauthenticated");
    await next();
  });
}

export function registerSessionRoutes(app: Hono): void {
  // SPA boot check: does this instance require login, and is the caller in?
  app.get("/api/session", (c) =>
    c.json({ required: accessControlEnabled(), authenticated: sessionUser(c) !== null }),
  );

  // Submit the instance access token → set the signed session cookie.
  app.post("/api/session", async (c) => {
    if (!accessControlEnabled()) return c.json({ ok: true, required: false });
    let token = "";
    try {
      token = (JSON.parse((await c.req.text()) || "{}") as { token?: string }).token ?? "";
    } catch {
      /* invalid body → token stays empty → 401 */
    }
    if (!tokenOk(token)) return err(c, 401, "invalid_access_token");
    setCookie(c, COOKIE, makeSessionCookie(OWNER_ID), { ...COOKIE_OPTS, maxAge: MAX_AGE });
    return c.json({ ok: true });
  });

  // Log out.
  app.post("/api/session/logout", (c) => {
    setCookie(c, COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 });
    return c.json({ ok: true });
  });
}

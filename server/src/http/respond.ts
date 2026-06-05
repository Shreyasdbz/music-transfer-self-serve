// Small Hono response helpers shared across route modules — keeps the v1 JSON
// error shape (`{ error: <message> }`) and the OAuth auto-close popup page.

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** JSON error body, preserving the v1 `{ error: <message> }` shape. */
export function err(c: Context, status: ContentfulStatusCode, message: string): Response {
  return c.json({ error: message }, status);
}

/** HTML-escape the five characters that matter for attribute / text contexts. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A tiny self-closing HTML page used by both OAuth callbacks. `message` is
 * HTML-escaped; callers pass FIXED strings (never user-controlled query params).
 * A strict CSP blocks any external script and limits inline JS to the bootstrap
 * below (defense-in-depth against a reflected-script vector on the callback). */
export function autoCloseHtml(c: Context, message: string): Response {
  const safe = escapeHtml(message);
  const html = `<!doctype html><meta charset="utf-8"><title>${safe}</title>
<style>body{font-family:-apple-system,sans-serif;padding:2rem;color:#222}</style>
<p>${safe}</p><p>You can close this window.</p>
<script>setTimeout(()=>{try{window.close()}catch(_){}}, 250);</script>`;
  return c.html(html, 200, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  });
}

/** Parse a JSON request body, preserving the v1 semantics: an EMPTY body is
 * `{}` (not an error), a malformed body throws so the caller can map it to a
 * 400. (Body-size is capped by the bodyLimit middleware → 413 before we get
 * here.) */
export async function readJson<T>(c: Context): Promise<T> {
  const raw = await c.req.text();
  if (raw.length === 0) return {} as T;
  return JSON.parse(raw) as T;
}

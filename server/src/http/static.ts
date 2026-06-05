// Static file handler for WEB_DIR (Hono). Injects the per-server-start CSRF
// token into served HTML as <meta name="csrf-token" content="...">. Restricted
// to files inside WEB_DIR via a path-prefix check (defense in depth).
//
// (V3: serves the kept vanilla UI at server/web — the regression oracle. V5/V6
// switch WEB_DIR/serving to the built Vite app at web/dist.)

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, normalize, resolve, sep } from "node:path";
import { WEB_DIR } from "../config.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function resolveSafe(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined; // malformed percent-encoding → 404
  }
  const target = normalize(resolve(WEB_DIR, "." + decoded));
  if (target !== WEB_DIR && !target.startsWith(WEB_DIR + sep)) return undefined;
  if (!existsSync(target)) return undefined;
  const st = statSync(target);
  if (st.isDirectory()) {
    const index = resolve(target, "index.html");
    return existsSync(index) ? index : undefined;
  }
  return target;
}

const STATIC_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;
const META_TAG_RE = /<meta\s+[^>]*\bname=["']csrf-token["'][^>]*>/i;

/** Serve a static file under WEB_DIR for `pathname`, injecting the CSRF token
 * into HTML. Returns a Response, or undefined if no such file (caller → 404). */
export function serveStaticFile(pathname: string, csrfToken: string): Response | undefined {
  const filePath = resolveSafe(pathname);
  if (!filePath) return undefined;

  const ext = extname(filePath).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";

  if (ext === ".html") {
    let body = readFileSync(filePath, "utf8");
    const metaTag = `<meta name="csrf-token" content="${csrfToken}">`;
    if (META_TAG_RE.test(body)) {
      body = body.replace(META_TAG_RE, metaTag);
    } else if (body.includes("</head>")) {
      body = body.replace("</head>", `    ${metaTag}\n  </head>`);
    } else {
      body = metaTag + body;
    }
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": type, ...STATIC_HEADERS },
    });
  }

  // Non-HTML: return the bytes (Response sets Content-Length from the body).
  const buf = readFileSync(filePath);
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: { "Content-Type": type, ...STATIC_HEADERS },
  });
}

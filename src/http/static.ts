// Static file handler for web/. Injects the per-server-start CSRF token into
// served HTML as <meta name="csrf-token" content="...">.
//
// Restricted to files inside WEB_DIR via path-prefix check, even though the
// only caller is our own router — defense in depth against accidental future
// path concatenation bugs.

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
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

function resolveSafe(urlPath: string): string | undefined {
  const clean = urlPath.split("?")[0] ?? "/";
  const decoded = decodeURIComponent(clean);
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

export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  csrfToken: string,
): boolean {
  const url = req.url ?? "/";
  const filePath = resolveSafe(url);
  if (!filePath) return false;

  const ext = extname(filePath).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";

  if (ext === ".html") {
    // Inject the CSRF token <meta> tag. We rewrite the response body in
    // memory — these files are tiny.
    //
    // Detection has to look for an actual `<meta ... name="csrf-token" ...>`
    // tag, not just any occurrence of the string `name="csrf-token"`, because
    // the static page is allowed to contain JS that READS the tag
    // (e.g. `document.querySelector('meta[name="csrf-token"]')`). An overly
    // liberal check matched that JS, ran a regex replace that found nothing,
    // and silently shipped the page with no token — which then 403'd every
    // subsequent POST. Test fixture: musickit.html bit by exactly this.
    let body = readFileSync(filePath, "utf8");
    const metaTag = `<meta name="csrf-token" content="${csrfToken}">`;
    const META_TAG_RE = /<meta\s+[^>]*\bname=["']csrf-token["'][^>]*>/i;
    if (META_TAG_RE.test(body)) {
      body = body.replace(META_TAG_RE, metaTag);
    } else if (body.includes("</head>")) {
      body = body.replace("</head>", `    ${metaTag}\n  </head>`);
    } else {
      body = metaTag + body;
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
    return true;
  }

  const st = statSync(filePath);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": st.size,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(filePath).pipe(res);
  return true;
}

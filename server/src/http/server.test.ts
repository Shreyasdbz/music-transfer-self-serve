// Phase 1 AC #2 + #3 coverage as automated tests (was previously only verified
// live via curl — see PROGRESS.md).
//
//   AC #2: Host check — 127.0.0.1 → 200, localhost → 403.
//   AC #3: CSRF + Origin on POSTs — no CSRF → 403, wrong → 403, valid+Origin
//          → 200, valid CSRF + wrong Origin → 403.
//
// AC #4 (startup reconciliation sweep) is covered by src/ledger/db.test.ts.

import { connect } from "node:net";
import { startHttpServer } from "./server.js";
import { stopStateSweeper } from "../auth/spotify.js";
import { stopNonceSweeper } from "../auth/apple.js";

/** Send a raw HTTP/1.1 request and read the response. Used for the Host-
 * header AC because Node's fetch silently overrides the Host header to
 * match the URL (so we can't test rejecting Host=localhost via fetch). */
function rawRequest(host: string, path: string): Promise<{ status: number; headers: Map<string, string>; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect(8888, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    socket.on("data", (d) => (buf += d.toString()));
    socket.on("end", () => {
      const [headerBlock, body = ""] = buf.split("\r\n\r\n", 2);
      const lines = headerBlock?.split("\r\n") ?? [];
      const statusLine = lines[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? 0);
      const headers = new Map<string, string>();
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        if (i > 0) headers.set(line.slice(0, i).toLowerCase().trim(), line.slice(i + 1).trim());
      }
      resolvePromise({ status, headers, body });
    });
    socket.on("error", rejectPromise);
  });
}

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    process.stderr.write(`FAIL  ${msg}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS  ${msg}\n`);
  }
}

// startHttpServer() now builds the Hono app and registers every route module
// (incl. auth — the Spotify callback exercised by the XSS test below).
const handle = await startHttpServer();

try {
  // ── AC #2 — Host header ────────────────────────────────────────────────
  // Use a raw TCP socket — Node's fetch silently overrides the Host header
  // to match the URL host, so it can't exercise this code path.

  const ok = await rawRequest("127.0.0.1:8888", "/api/health");
  assert(ok.status === 200, `AC2: Host=127.0.0.1:8888 → 200 (got ${ok.status})`);

  const bad = await rawRequest("localhost:8888", "/api/health");
  assert(bad.status === 403, `AC2: Host=localhost:8888 → 403 (got ${bad.status})`);

  // ── AC #3 — CSRF + Origin on POST ──────────────────────────────────────

  const noCsrf = await fetch("http://127.0.0.1:8888/api/health", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8888" },
  });
  assert(noCsrf.status === 403, `AC3: POST without CSRF → 403 (got ${noCsrf.status})`);

  const wrongCsrf = await fetch("http://127.0.0.1:8888/api/health", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8888", "X-CSRF-Token": "bogus" },
  });
  assert(wrongCsrf.status === 403, `AC3: POST with wrong CSRF → 403 (got ${wrongCsrf.status})`);

  const wrongOrigin = await fetch("http://127.0.0.1:8888/api/health", {
    method: "POST",
    headers: { Origin: "http://evil.example", "X-CSRF-Token": handle.csrfToken },
  });
  assert(wrongOrigin.status === 403, `AC3: POST wrong Origin → 403 (got ${wrongOrigin.status})`);

  const good = await fetch("http://127.0.0.1:8888/api/health", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8888", "X-CSRF-Token": handle.csrfToken },
  });
  assert(good.status === 200, `AC3: POST valid CSRF + Origin → 200 (got ${good.status})`);

  // ── XSS regression fix (security finding #1) ───────────────────────────
  // The Spotify OAuth callback used to echo ?error= raw into HTML. Now it
  // returns a fixed string. Verify a callback with a script-tag error param
  // emits HTML that contains NEITHER the raw <script> nor any HTML-escaped
  // injection of the attacker string.
  const xssAttempt = await fetch(
    "http://127.0.0.1:8888/auth/spotify/callback?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
  );
  const body = await xssAttempt.text();
  assert(
    !body.includes("<script>alert"),
    `XSS-fix: callback body does not contain attacker <script> (snippet=${body.slice(0, 200)})`,
  );
  assert(
    !body.includes("&lt;script&gt;alert"),
    `XSS-fix: callback body does not even echo escaped attacker string`,
  );
  assert(
    body.includes("Spotify authorization cancelled"),
    "XSS-fix: callback shows the fixed message",
  );

  // CSP header on auto-close page
  assert(
    (xssAttempt.headers.get("content-security-policy") ?? "").includes("default-src 'none'"),
    `XSS-fix: CSP default-src 'none' present (got "${xssAttempt.headers.get("content-security-policy")}")`,
  );
} finally {
  stopStateSweeper();
  stopNonceSweeper();
  await handle.close();
}

process.exit(process.exitCode ?? 0);

// V6 access-gate HTTP test (blueprint §15 A3). config.ts reads env at module
// eval, so INSTANCE_ACCESS_TOKEN + SESSION_SECRET are set BEFORE any import that
// pulls config. Uses a REAL server (startHttpServer) + fetch, because the Host
// allowlist needs a real Host header (fetch sets it; Hono's app.request can't).
// Exercises the security-critical path: the gate at the HTTP layer, exempt
// routes, the token->cookie exchange, and cookie unlock. Snapshots the ledger.

const TOKEN = "test-instance-access-token-1234567890";
process.env["INSTANCE_ACCESS_TOKEN"] = TOKEN;
process.env["SESSION_SECRET"] = "session-gate-test-hmac-secret-000000";

// node:fs is config-independent, so a static import is fine. Everything that
// transitively reads config.ts MUST be dynamically imported AFTER the env is
// set above — ESM hoists static imports ahead of these assignments, which would
// make config read an empty INSTANCE_ACCESS_TOKEN (gate disabled).
import { existsSync, copyFileSync, unlinkSync } from "node:fs";
const { startHttpServer } = await import("./server.js");
const { LEDGER_PATH } = await import("../config.js");
const { closeLedger } = await import("../ledger/db.js");
const { stopStateSweeper } = await import("../auth/spotify.js");
const { stopNonceSweeper } = await import("../auth/apple.js");

function assert(c: unknown, m: string): void {
  if (!c) {
    process.stderr.write(`FAIL  ${m}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS  ${m}\n`);
}

// Isolate the real ledger (startHttpServer opens it).
const SNAP = LEDGER_PATH + ".gate-test-snap";
const _had = existsSync(LEDGER_PATH);
if (_had) copyFileSync(LEDGER_PATH, SNAP);
function restoreLedger(): void {
  try {
    closeLedger();
  } catch {
    /* ignore */
  }
  for (const side of [`${LEDGER_PATH}-wal`, `${LEDGER_PATH}-shm`]) {
    if (existsSync(side)) {
      try {
        unlinkSync(side);
      } catch {
        /* ignore */
      }
    }
  }
  if (_had) {
    copyFileSync(SNAP, LEDGER_PATH);
    try {
      unlinkSync(SNAP);
    } catch {
      /* ignore */
    }
  } else if (existsSync(LEDGER_PATH)) {
    try {
      unlinkSync(LEDGER_PATH);
    } catch {
      /* ignore */
    }
  }
}
process.on("exit", restoreLedger);
process.on("SIGINT", () => {
  restoreLedger();
  process.exit(130);
});

const B = "http://127.0.0.1:8888";
const handle = await startHttpServer();

const get = (path: string, cookie?: string): Promise<Response> =>
  fetch(`${B}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
const postJson = (path: string, body: unknown, cookie?: string): Promise<Response> =>
  fetch(`${B}${path}`, {
    method: "POST",
    headers: {
      Origin: B,
      "X-CSRF-Token": handle.csrfToken,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });

try {
  // (a) A protected route with no cookie → 401 (gate short-circuits the handler).
  const noCookie = await get("/api/auth/status");
  assert(
    noCookie.status === 401,
    `protected /api/auth/status without cookie → 401 (got ${noCookie.status})`,
  );
  assert(
    ((await noCookie.json()) as { error?: string }).error === "unauthenticated",
    "401 body {error:'unauthenticated'}",
  );

  // (b) Exempt routes are reachable pre-login.
  assert((await get("/api/health")).status === 200, "exempt /api/health → 200");
  assert((await get("/api/csrf")).status === 200, "exempt /api/csrf → 200");
  const sess = await get("/api/session");
  assert(sess.status === 200, "exempt /api/session → 200");
  const sessBody = (await sess.json()) as { required?: boolean; authenticated?: boolean };
  assert(
    sessBody.required === true && sessBody.authenticated === false,
    "GET /api/session → {required:true, authenticated:false} pre-login",
  );

  // (c) Wrong token → 401; valid token → 200 + Set-Cookie.
  const wrong = await postJson("/api/session", { token: "nope" });
  assert(wrong.status === 401, `POST /api/session wrong token → 401 (got ${wrong.status})`);
  assert(
    ((await wrong.json()) as { error?: string }).error === "invalid_access_token",
    "wrong token → {error:'invalid_access_token'}",
  );

  const login = await postJson("/api/session", { token: TOKEN });
  assert(login.status === 200, `POST /api/session valid token → 200 (got ${login.status})`);
  const setCookie = login.headers.get("set-cookie") ?? "";
  assert(
    setCookie.startsWith("mtss_session="),
    `login sets mtss_session cookie (got "${setCookie.slice(0, 40)}")`,
  );
  assert(
    /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie),
    "cookie is HttpOnly + SameSite=Strict",
  );
  const cookie = setCookie.split(";")[0]!; // "mtss_session=<payload>.<mac>"

  // (d) The cookie unlocks protected routes (gate passes).
  const withCookie = await get("/api/auth/status", cookie);
  assert(
    withCookie.status === 200,
    `protected /api/auth/status WITH cookie → 200 (got ${withCookie.status})`,
  );
  const sess2 = (await (await get("/api/session", cookie)).json()) as { authenticated?: boolean };
  assert(sess2.authenticated === true, "GET /api/session with cookie → authenticated:true");

  // (e) Logout clears the cookie (Max-Age=0).
  const logout = await postJson("/api/session/logout", {}, cookie);
  assert(logout.status === 200, `POST /api/session/logout → 200 (got ${logout.status})`);
  const cleared = logout.headers.get("set-cookie") ?? "";
  assert(
    /Max-Age=0/i.test(cleared),
    `logout clears cookie (Max-Age=0) (got "${cleared.slice(0, 60)}")`,
  );

  process.stdout.write("session_gate.test.ts done\n");
} finally {
  stopStateSweeper();
  stopNonceSweeper();
  await handle.close();
}

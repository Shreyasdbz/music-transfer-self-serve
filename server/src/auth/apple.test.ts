// Phase 3 AC asserts. Run via `npm run test:apple`; exits 1 on failure.
//
// AC #2: The developer token in the popup HTML decodes to a JWT with
//        `exp` ≤ 10 minutes from now. Must NOT be the 180-day token.
// AC #3: POST /api/auth/apple/callback with an unknown nonce → 403; older
//        than 10 min → 403 + entry purged; nonces are single-use.
// AC #4: nonce sweeper purges expired entries, retains fresh ones (mirror
//        of the Spotify AC #4 we landed during the Phase 2 close-out).

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import jwt from "jsonwebtoken";

// IMPORTANT: snapshot data/tokens.json BEFORE importing apple.ts. The AC #3(d)
// flow exercises handleCallback("fresh-nonce", "test-mut-value"), which writes
// the fake MUT to the real tokens file. We restore the FILE STATE (present vs
// absent) at exit so a test run never leaves the user appearing "connected"
// with a junk MUT — including on a fresh clone where tokens.json didn't
// exist before the test ran.
const TOKENS_PATH = resolve(import.meta.dirname, "..", "..", "data", "tokens.json");
const _hadTokensFile = existsSync(TOKENS_PATH);
const _tokensSnapshot = _hadTokensFile ? readFileSync(TOKENS_PATH, "utf8") : null;
function restoreTokens(): void {
  if (_tokensSnapshot !== null) {
    // File existed before — restore its content.
    writeFileSync(TOKENS_PATH, _tokensSnapshot, { mode: 0o600 });
  } else if (existsSync(TOKENS_PATH)) {
    // File did NOT exist before, but the test wrote one — remove it so the
    // user isn't left with a junk MUT on disk (the original bug this guard
    // fixed had a hole for exactly this case).
    try {
      unlinkSync(TOKENS_PATH);
    } catch {
      // best-effort
    }
  }
}
process.on("exit", restoreTokens);
process.on("SIGINT", () => {
  restoreTokens();
  process.exit(130);
});

import {
  __test as appleTest,
  buildPopupStart,
  getLongLivedDevToken,
  handleCallback,
  mintPopupDevToken,
} from "./apple.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    process.stderr.write(`FAIL  ${msg}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS  ${msg}\n`);
  }
}

function skip(msg: string): void {
  process.stdout.write(`SKIP  ${msg}\n`);
}

const ROOT = resolve(import.meta.dirname, "..", "..");
const envPath = resolve(ROOT, ".env");
const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
function envVal(key: string): string | undefined {
  const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m?.[1]?.trim() || undefined;
}

// Apple JWT tests need a real .p8 + Team/Key IDs. We pull from .env when
// present; if not (fresh clone), SKIP the JWT-dependent assertions and rely
// on the runtime errors + Phase 5 preflight to cover them later.
const teamId = envVal("APPLE_TEAM_ID");
const keyId = envVal("APPLE_KEY_ID");
const keyPath = envVal("APPLE_PRIVATE_KEY_PATH");
const keyExists = keyPath && existsSync(resolve(ROOT, keyPath));

if (teamId && keyId && keyPath && keyExists) {
  // Propagate to process.env so loadAppleConfig succeeds.
  process.env["APPLE_TEAM_ID"] = teamId;
  process.env["APPLE_KEY_ID"] = keyId;
  process.env["APPLE_PRIVATE_KEY_PATH"] = keyPath;

  // --- AC #2: popup JWT lifetime ≤ 10 min --------------------------------

  const popup = mintPopupDevToken();
  const decoded = jwt.decode(popup, { complete: true });
  assert(
    decoded?.header?.alg === "ES256",
    `AC2(a): popup JWT alg=ES256 (got ${decoded?.header?.alg})`,
  );
  assert(decoded?.header?.kid === keyId, "AC2(a): popup JWT kid === APPLE_KEY_ID");

  const payload = decoded?.payload as { iss?: string; exp?: number; iat?: number } | undefined;
  assert(payload?.iss === teamId, "AC2(a): popup JWT iss === APPLE_TEAM_ID");
  const nowSec = Math.floor(Date.now() / 1000);
  const ttl = (payload?.exp ?? 0) - nowSec;
  assert(
    ttl > 0 && ttl <= appleTest.popupTtlSeconds + 5,
    `AC2(b): popup JWT TTL ${ttl}s within (0, ${appleTest.popupTtlSeconds + 5}s] window`,
  );

  // Long-lived must be much longer than the popup one — sanity check the cap.
  const long = getLongLivedDevToken();
  const longPayload = jwt.decode(long) as { exp?: number } | null;
  const longTtl = (longPayload?.exp ?? 0) - nowSec;
  assert(
    longTtl > 30 * 24 * 60 * 60,
    `AC2(c): long-lived JWT TTL ${Math.round(longTtl / 86400)}d > 30 days`,
  );
  assert(
    longTtl <= 181 * 24 * 60 * 60,
    `AC2(c): long-lived JWT TTL ${Math.round(longTtl / 86400)}d ≤ 181 days (180+leeway)`,
  );

  // --- AC #3: nonce validation -------------------------------------------

  appleTest.clear();

  const r1 = handleCallback("never-existed-nonce", "fake-mut");
  assert(r1.kind === "nonce_unknown", `AC3(a): unknown nonce → nonce_unknown (got ${r1.kind})`);

  // Expired (>10min) nonce → 403 + entry purged
  appleTest.injectNonce("expired-nonce", Date.now() - 11 * 60 * 1000);
  assert(appleTest.hasNonce("expired-nonce"), "AC3(b): expired nonce seeded");
  const r2 = handleCallback("expired-nonce", "fake-mut");
  assert(r2.kind === "nonce_expired", `AC3(b): expired → nonce_expired (got ${r2.kind})`);
  assert(!appleTest.hasNonce("expired-nonce"), "AC3(b): expired entry purged");

  // Fresh nonce + missing MUT → mut_missing
  appleTest.injectNonce("fresh-nonce", Date.now());
  const r3 = handleCallback("fresh-nonce", "");
  assert(r3.kind === "mut_missing", `AC3(c): empty MUT → mut_missing (got ${r3.kind})`);
  // The mut_missing path returns BEFORE we look up the nonce, so the entry
  // stays — the caller can retry with a real MUT.
  assert(appleTest.hasNonce("fresh-nonce"), "AC3(c): nonce retained on mut_missing");

  // Fresh nonce + non-empty MUT → ok, nonce consumed exactly once
  const r4 = handleCallback("fresh-nonce", "test-mut-value");
  assert(r4.kind === "ok", `AC3(d): fresh nonce + MUT → ok (got ${r4.kind})`);
  assert(!appleTest.hasNonce("fresh-nonce"), "AC3(d): nonce consumed after ok");
  const r5 = handleCallback("fresh-nonce", "test-mut-value");
  assert(
    r5.kind === "nonce_unknown",
    `AC3(d): replay of consumed nonce → nonce_unknown (got ${r5.kind})`,
  );

  // --- AC #4: nonce sweeper ----------------------------------------------

  appleTest.clear();
  const now = Date.now();
  appleTest.injectNonce("n-fresh", now);
  appleTest.injectNonce("n-recent", now - 9 * 60 * 1000);
  appleTest.injectNonce("n-stale", now - 11 * 60 * 1000);
  appleTest.injectNonce("n-ancient", now - 60 * 60 * 1000);
  assert(appleTest.size() === 4, `AC4: nonce sweeper seeded 4 (got ${appleTest.size()})`);
  const purged = appleTest.runSweep();
  assert(purged === 2, `AC4: nonce sweeper purged 2 (got ${purged})`);
  assert(appleTest.hasNonce("n-fresh"), "AC4: fresh survives");
  assert(appleTest.hasNonce("n-recent"), "AC4: 9min entry survives");
  assert(!appleTest.hasNonce("n-stale"), "AC4: 11min entry purged");
  assert(!appleTest.hasNonce("n-ancient"), "AC4: 1h entry purged");

  // buildPopupStart also nonce-store-mutates — confirm shape and population.
  appleTest.clear();
  const start = buildPopupStart();
  assert(
    typeof start.developerToken === "string" && start.developerToken.length > 100,
    "AC2(d): buildPopupStart returns a non-empty developerToken",
  );
  assert(
    typeof start.nonce === "string" && start.nonce.length >= 32,
    "AC3(e): buildPopupStart returns a ≥32-char nonce",
  );
  assert(
    appleTest.hasNonce(start.nonce),
    "AC3(e): buildPopupStart inserts the nonce into the store",
  );

  appleTest.clear();
} else {
  const missing: string[] = [];
  if (!teamId) missing.push("APPLE_TEAM_ID");
  if (!keyId) missing.push("APPLE_KEY_ID");
  if (!keyPath) missing.push("APPLE_PRIVATE_KEY_PATH");
  if (keyPath && !keyExists) missing.push(`${keyPath} (file)`);
  skip(`AC2/3/4: Apple JWT-dependent tests need real creds. Missing: ${missing.join(", ")}`);
}

process.exit(process.exitCode ?? 0);

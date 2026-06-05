// Session/access-seam unit tests (blueprint §15 A3). config.ts reads env at
// module-eval, so we set INSTANCE_ACCESS_TOKEN + SESSION_SECRET BEFORE the
// dynamic import. Pure crypto — no DB, no network, no HTTP server.

process.env["INSTANCE_ACCESS_TOKEN"] = "s3cret-access-token-value";
process.env["SESSION_SECRET"] = "unit-test-hmac-secret-key-0000000000";

function assert(c: unknown, m: string): void {
  if (!c) {
    process.stderr.write(`FAIL  ${m}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS  ${m}\n`);
}

const { makeSessionCookie, verifySessionCookie, accessControlEnabled, OWNER_ID } =
  await import("./session.js");

// accessControlEnabled reflects the env token.
assert(accessControlEnabled() === true, "accessControlEnabled true when INSTANCE_ACCESS_TOKEN set");

// Round-trip: a freshly minted cookie verifies and carries the owner id.
const cookie = makeSessionCookie(OWNER_ID);
assert(cookie.includes("."), "cookie is <payload>.<mac>");
const ok = verifySessionCookie(cookie);
assert(ok !== null && ok.userId === OWNER_ID, "valid cookie verifies to OWNER_ID");
assert(ok !== null && typeof ok.iat === "number", "verified session carries iat");

// Tamper with the payload → MAC mismatch → null (no throw).
const [payload, mac] = cookie.split(".");
const forged = `${payload}x.${mac}`;
assert(verifySessionCookie(forged) === null, "tampered payload rejected");

// Tamper with the MAC (same length) → rejected.
const badMacChar = mac!.charAt(0) === "A" ? "B" : "A";
assert(
  verifySessionCookie(`${payload}.${badMacChar}${mac!.slice(1)}`) === null,
  "tampered mac rejected",
);

// A cookie signed with a different secret must NOT verify under our secret.
// Re-import the module fresh in a child env is awkward; instead forge a cookie
// whose MAC is a plausible-but-wrong base64url string of the right length.
assert(
  verifySessionCookie(`${payload}.${"A".repeat(mac!.length)}`) === null,
  "wrong-secret-shaped mac rejected",
);

// Empty / malformed inputs never throw and return null.
assert(verifySessionCookie(undefined) === null, "undefined → null");
assert(verifySessionCookie("") === null, "empty → null");
assert(verifySessionCookie("no-dot-here") === null, "no separator → null");
assert(verifySessionCookie(".onlymac") === null, "empty payload → null");

// The payload is secretless: it decodes to exactly { userId, iat }.
const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<
  string,
  unknown
>;
assert(
  Object.keys(decoded).sort().join(",") === "iat,userId",
  "cookie payload carries only { userId, iat } — no secret",
);

process.stdout.write("session.test.ts done\n");

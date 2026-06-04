// Phase 2 AC asserts. Run via `npx tsx src/auth/spotify.test.ts`; exits 1 on
// any failed assertion. This is intentionally test-framework-free — keeps the
// dep list at the §2 minimum.
//
// AC #2: SPOTIFY_REDIRECT_URI byte-equality across:
//   - .env.example default
//   - SPOTIFY_REDIRECT_URI_EXPECTED constant in config.ts
//   - the /api/auth/spotify/start authorize URL (URL-decoded redirect_uri)
//   - the /auth/spotify/callback route literal in routes_auth.ts
//
// AC #3: state validation in handleCallback — unknown state → state_unknown;
// expired (>10min) state → state_expired, entry purged.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SPOTIFY_REDIRECT_URI_EXPECTED } from "../config.js";
import { __test as spotifyTest, buildAuthorizeUrl, handleCallback } from "./spotify.js";

const ROOT = resolve(import.meta.dirname, "..", "..");

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    process.stderr.write(`FAIL  ${msg}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS  ${msg}\n`);
  }
}

// --- Phase 2 AC #2 ---------------------------------------------------------

// (a) .env.example default
const envExample = readFileSync(resolve(ROOT, ".env.example"), "utf8");
const m = envExample.match(/^SPOTIFY_REDIRECT_URI=(.*)$/m);
assert(m !== null, "AC2(a): .env.example has SPOTIFY_REDIRECT_URI line");
const envExampleValue = m?.[1]?.trim() ?? "";
assert(
  envExampleValue === SPOTIFY_REDIRECT_URI_EXPECTED,
  `AC2(a): .env.example value === expected ("${envExampleValue}" vs "${SPOTIFY_REDIRECT_URI_EXPECTED}")`,
);

// (b) the route literal in routes_auth.ts
const routesSrc = readFileSync(resolve(ROOT, "src/http/routes_auth.ts"), "utf8");
const ROUTE_LITERAL = "/auth/spotify/callback";
assert(
  routesSrc.includes(`"${ROUTE_LITERAL}"`),
  `AC2(b): routes_auth.ts registers GET "${ROUTE_LITERAL}"`,
);
assert(
  SPOTIFY_REDIRECT_URI_EXPECTED.endsWith(ROUTE_LITERAL),
  `AC2(b): SPOTIFY_REDIRECT_URI_EXPECTED ends with the route literal "${ROUTE_LITERAL}"`,
);

// (c) authorize URL's redirect_uri param decodes byte-equal to expected
//     buildAuthorizeUrl() needs env. Set the minimum keys if absent.
if (!process.env["SPOTIFY_CLIENT_ID"]) process.env["SPOTIFY_CLIENT_ID"] = "test_client_id";
if (!process.env["SPOTIFY_REDIRECT_URI"]) process.env["SPOTIFY_REDIRECT_URI"] = SPOTIFY_REDIRECT_URI_EXPECTED;
if (!process.env["APPLE_TEAM_ID"]) process.env["APPLE_TEAM_ID"] = "ZZZTEAMZZZZ";
if (!process.env["APPLE_KEY_ID"]) process.env["APPLE_KEY_ID"] = "ZZZKEYZZZZZ";
if (!process.env["APPLE_PRIVATE_KEY_PATH"]) process.env["APPLE_PRIVATE_KEY_PATH"] = ".env.example"; // any readable file
const { authorizeUrl } = buildAuthorizeUrl();
const parsed = new URL(authorizeUrl);
const fromUrl = parsed.searchParams.get("redirect_uri") ?? "";
assert(
  fromUrl === SPOTIFY_REDIRECT_URI_EXPECTED,
  `AC2(c): authorize URL redirect_uri === expected ("${fromUrl}" vs "${SPOTIFY_REDIRECT_URI_EXPECTED}")`,
);

// --- Phase 2 AC #3 ---------------------------------------------------------

spotifyTest.clear();

// Unknown state → state_unknown
const r1 = await handleCallback("never-existed", "any-code");
assert(r1.kind === "state_unknown", `AC3(a): unknown state → state_unknown (got ${r1.kind})`);

// Expired state → state_expired and entry purged
spotifyTest.injectState("expired-state", "verifier", Date.now() - 11 * 60 * 1000);
assert(spotifyTest.hasState("expired-state"), "AC3(b): expired state seeded");
const r2 = await handleCallback("expired-state", "any-code");
assert(r2.kind === "state_expired", `AC3(b): expired state → state_expired (got ${r2.kind})`);
assert(!spotifyTest.hasState("expired-state"), "AC3(b): expired state entry purged");

process.exit(process.exitCode ?? 0);

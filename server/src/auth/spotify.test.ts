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

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SPOTIFY_REDIRECT_URI_EXPECTED } from "../config.js";
import {
  __test as spotifyTest,
  buildAuthorizeUrl,
  handleCallback,
  REQUIRED_SPOTIFY_SCOPES,
} from "./spotify.js";

const ROOT = resolve(import.meta.dirname, "..", "..");

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
if (!process.env["SPOTIFY_REDIRECT_URI"])
  process.env["SPOTIFY_REDIRECT_URI"] = SPOTIFY_REDIRECT_URI_EXPECTED;
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

// (d) .env byte-equality — guarded. .env is gitignored, so this only runs
// where it's actually present (dev machine with creds), and only when the
// SPOTIFY_REDIRECT_URI line has a value. Where .env is absent or empty,
// loadSpotifyConfig() at runtime + Phase 5's `env` preflight cover this.
const envPath = resolve(ROOT, ".env");
if (existsSync(envPath)) {
  const env = readFileSync(envPath, "utf8");
  const em = env.match(/^SPOTIFY_REDIRECT_URI=(.*)$/m);
  const envValue = em?.[1]?.trim() ?? "";
  if (envValue) {
    assert(
      envValue === SPOTIFY_REDIRECT_URI_EXPECTED,
      `AC2(d): .env SPOTIFY_REDIRECT_URI === expected ("${envValue}" vs "${SPOTIFY_REDIRECT_URI_EXPECTED}")`,
    );
  } else {
    skip(
      "AC2(d): .env present but SPOTIFY_REDIRECT_URI is empty (covered by runtime loadSpotifyConfig)",
    );
  }
} else {
  skip("AC2(d): .env not present — gitignored, dev-only check");
}

// (e) Sanity-check the authorize URL has every required scope, S256
// challenge, and a 32-byte base64url state. Cheap defense against the
// flow being silently weakened in the future.
const urlScopes = (parsed.searchParams.get("scope") ?? "").split(" ");
const missingScopes = REQUIRED_SPOTIFY_SCOPES.filter((s) => !urlScopes.includes(s));
assert(
  missingScopes.length === 0,
  `AC2(e): authorize URL contains all 6 required scopes (missing: ${missingScopes.join(", ") || "none"})`,
);
assert(
  parsed.searchParams.get("code_challenge_method") === "S256",
  "AC2(e): authorize URL uses S256 code challenge",
);
assert(
  (parsed.searchParams.get("state") ?? "").length >= 32,
  "AC2(e): authorize URL state is ≥32 chars (base64url of 32 random bytes)",
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

// --- Sweeper — directly exercise the purge logic the 60s interval runs ----

spotifyTest.clear();
const now = Date.now();
spotifyTest.injectState("fresh", "v1", now); // 0 min old
spotifyTest.injectState("recent", "v2", now - 9 * 60 * 1000); // 9 min old (under TTL)
spotifyTest.injectState("stale", "v3", now - 11 * 60 * 1000); // 11 min old (expired)
spotifyTest.injectState("ancient", "v4", now - 60 * 60 * 1000); // 1 hr old (expired)
assert(spotifyTest.size() === 4, `AC4: sweeper test seeded 4 entries (got ${spotifyTest.size()})`);

const purged = spotifyTest.runSweep();
assert(purged === 2, `AC4: sweeper purged 2 expired entries (got ${purged})`);
assert(spotifyTest.hasState("fresh"), "AC4: fresh entry survives sweep");
assert(spotifyTest.hasState("recent"), "AC4: <10min entry survives sweep");
assert(!spotifyTest.hasState("stale"), "AC4: 11min entry purged");
assert(!spotifyTest.hasState("ancient"), "AC4: 1h entry purged");
assert(spotifyTest.size() === 2, `AC4: store size after sweep == 2 (got ${spotifyTest.size()})`);

// A second sweep with the same `now` should be a no-op (idempotent).
const purged2 = spotifyTest.runSweep(now);
assert(purged2 === 0, `AC4: re-running sweeper purges 0 (got ${purged2})`);

spotifyTest.clear();

process.exit(process.exitCode ?? 0);

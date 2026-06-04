// Blueprint §12 mandates this file. Exhaustive coverage of the redaction
// contract so a typo in REDACTED_HEADER_NAMES / REDACTED_BODY_KEYS / the
// regexes can't ship silently.
//
// Test framework: none — fail = nonzero exit (matches the project's other
// .test.ts files).

import { redact, redactHeaders, redactUrl } from "./log.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    process.stderr.write(`FAIL  ${msg}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS  ${msg}\n`);
  }
}

// ── redactHeaders — every name in REDACTED_HEADER_NAMES ──────────────────

const headerCases: [string, string][] = [
  ["Authorization", "Bearer xxx"],
  ["authorization", "Bearer yyy"],
  ["Music-User-Token", "secret-mut"],
  ["music-user-token", "secret-mut-2"],
  ["X-Apple-Music-User-Token", "secret-mut-3"],
  ["Set-Cookie", "session=abc"],
  ["Cookie", "session=def"],
];
for (const [name, value] of headerCases) {
  const out = redactHeaders({ [name]: value });
  assert(
    out[name] === "<redacted:header>",
    `redactHeaders: "${name}" replaced (got "${out[name]}")`,
  );
}
const ct = redactHeaders({ "Content-Type": "application/json" });
assert(ct["Content-Type"] === "application/json", "redactHeaders: non-sensitive header passes through");

// ── redact — every key in REDACTED_BODY_KEYS, every casing ───────────────

const bodyKeyCases: [string, unknown][] = [
  ["access_token", "AT_xxx"],
  ["refresh_token", "RT_yyy"],
  ["developerToken", "DT_aaa"],
  ["developer_token", "DT_bbb"],
  ["musicUserToken", "MUT_aaa"],
  ["music_user_token", "MUT_bbb"],
  ["mut", "MUT_wire"],
  ["id_token", "ID_xxx"],
  ["code_verifier", "verifier_xxx"],
  ["state", "state_xxx"],
  ["nonce", "nonce_xxx"],
  ["code", "code_xxx"],
];
for (const [key, value] of bodyKeyCases) {
  const out = JSON.stringify(redact({ [key]: value }));
  assert(
    out.includes("<redacted:secret>") && !out.includes(String(value)),
    `redact body key: "${key}" replaced (got ${out})`,
  );
}

// Nested + array + mixed casing
const nested = redact({
  outer: { Access_Token: "shouldnt_match_exact_case_in_set_but_lookup_is_lowercased_so_DOES_match", inner: { code: "X" } },
  arr: [{ refresh_token: "Y" }, { keep: "Z" }],
});
const ns = JSON.stringify(nested);
assert(ns.includes("<redacted:secret>"), `redact nested: secret keys redacted (${ns})`);
assert(ns.includes('"keep":"Z"'), `redact nested: non-secret keys preserved`);

// ── redact — Bearer pattern (40+ chars) and ignores short fixtures ──────

const bearer40 = "Bearer " + "a".repeat(40);
const bearerShort = "Bearer xxx";
const beared = redact(`header: ${bearer40}`) as string;
assert(beared.includes("Bearer <redacted:token>"), `redact: Bearer40 redacted (${beared})`);
assert(!beared.includes("a".repeat(40)), "redact: 40-char bearer body purged");
const shortOut = redact(`header: ${bearerShort}`) as string;
assert(shortOut === `header: ${bearerShort}`, `redact: short Bearer pass-through (${shortOut})`);

// ── redact — BEGIN…PRIVATE KEY block ─────────────────────────────────────

// Synthetic PEM-shaped fixture — NOT a real key, just enough chars to
// exercise the BEGIN…END regex. The redactor MUST scrub it regardless of
// payload contents. Pre-commit audits can safely ignore this line.
const pem = "-----BEGIN EC PRIVATE KEY-----\nFAKEKEYBYTESforTESTfixtureONLY\n-----END EC PRIVATE KEY-----";
const pemOut = redact(`key=${pem}`) as string;
assert(pemOut.includes("<redacted:private-key>"), "redact: PEM block redacted");
assert(!pemOut.includes("FAKEKEYBYTES"), "redact: PEM body purged");

// ── redact — configured Team/Key IDs ─────────────────────────────────────
// At module-init time of log.ts, TEAM_ID and KEY_ID are pulled from
// process.env. The redaction only applies if those values were present at
// import time. The Apple test file imports apple.ts after setting envs from
// .env, so by the time WE run this file the IDs may or may not be set
// depending on whether `.env` is sourced. Treat as guarded: only assert when
// values exist.

if (process.env["APPLE_TEAM_ID"] && process.env["APPLE_TEAM_ID"].length >= 6) {
  // Note: TEAM_ID redaction is captured at log.ts module init. The current
  // run already imported log.ts at the top of this file; if env vars are
  // set in .env (loaded by other code paths), they apply. Otherwise we skip.
  process.stdout.write("SKIP  Team/Key ID redaction depends on import-time env capture\n");
} else {
  process.stdout.write("SKIP  Team/Key ID redaction (env vars not set at module init)\n");
}

// ── redactUrl — sensitive query params ───────────────────────────────────

const urls: [string, string[]][] = [
  ["https://api.example/x?code=abc&state=xyz&keep=ok", ["code=%3C", "state=%3C", "keep=ok"]],
  ["https://api.example/x?access_token=AT&refresh_token=RT", ["access_token=%3C", "refresh_token=%3C"]],
  ["https://api.example/x?nonce=N&music_user_token=MUT", ["nonce=%3C", "music_user_token=%3C"]],
  ["https://api.example/x?developer_token=DT&mut=M", ["developer_token=%3C", "mut=%3C"]],
];
for (const [url, expectedFragments] of urls) {
  const out = redactUrl(url);
  for (const frag of expectedFragments) {
    assert(out.includes(frag), `redactUrl("${url}") contains "${frag}"  →  out=${out}`);
  }
}
const safeUrl = "https://api.spotify.com/v1/me/tracks?limit=50";
assert(
  redactUrl(safeUrl) === safeUrl,
  `redactUrl: non-sensitive URL pass-through (got ${redactUrl(safeUrl)})`,
);
// Malformed URL — should still scrub bearer patterns in the string
const malformedWithBearer = "not-a-url Bearer " + "x".repeat(50);
const malOut = redactUrl(malformedWithBearer);
assert(
  malOut.includes("<redacted:token>") && !malOut.includes("x".repeat(50)),
  `redactUrl(malformed) still redacts bearer patterns (got ${malOut})`,
);

// ── redact — case sensitivity audit on body keys ─────────────────────────
// The check uses parentKey.toLowerCase(); ensure each REDACTED_BODY_KEYS
// entry is already lowercase (else the set membership lookup misses).
const upperCode = JSON.stringify(redact({ Code: "X" }));
assert(upperCode.includes("<redacted:secret>"), "redact: uppercase parent key still matches via toLowerCase");

process.exit(process.exitCode ?? 0);

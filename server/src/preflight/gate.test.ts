// Auto-invalidation logic (AC #5): the classifier + the util/http sink that
// fires it. No live network — global.fetch is stubbed.

import { classifyAuthFailure } from "./gate.js";
import { httpRequest, setAuthFailureSink } from "../util/http.js";

function assert(c: unknown, m: string): void {
  if (!c) {
    process.stderr.write(`FAIL  ${m}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS  ${m}\n`);
}

// ── classifier (pure) ────────────────────────────────────────────────────

assert(classifyAuthFailure(401, "") === "auth", "classify: 401 → auth");
assert(
  classifyAuthFailure(403, '{"error":{"message":"Insufficient client scope"}}') === "scope",
  "classify: 403 insufficient scope → scope",
);
assert(
  classifyAuthFailure(403, "permission denied") === "scope",
  "classify: 403 permission → scope",
);
assert(
  classifyAuthFailure(403, '{"error":"rate limit exceeded"}') === "none",
  "classify: 403 rate-limit → none",
);
assert(
  classifyAuthFailure(403, "too many requests") === "none",
  "classify: 403 too many requests → none",
);
assert(
  classifyAuthFailure(403, "some unrelated 403") === "none",
  "classify: 403 unknown → none (conservative)",
);
// Tightened (finding #3): generic auth words no longer force a scope verdict.
assert(
  classifyAuthFailure(403, "unauthorized") === "none",
  "classify: bare 'unauthorized' → none (too broad before)",
);
assert(
  classifyAuthFailure(403, "invalid access token") === "none",
  "classify: 'access token' → none (too broad before)",
);
assert(
  classifyAuthFailure(403, "insufficient scope for this request") === "scope",
  "classify: 'insufficient scope' → scope",
);
assert(
  classifyAuthFailure(403, "not authorized for that resource") === "scope",
  "classify: 'not authorized' → scope",
);
assert(classifyAuthFailure(429, "rate limit") === "none", "classify: 429 → none");
assert(classifyAuthFailure(200, "") === "none", "classify: 200 → none");
assert(classifyAuthFailure(500, "") === "none", "classify: 500 → none");

// ── http sink wiring ─────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
function stubFetch(sequence: { status: number; body: string }[]): void {
  let i = 0;
  globalThis.fetch = (async () => {
    const r = sequence[Math.min(i, sequence.length - 1)]!;
    i++;
    return new Response(r.body, { status: r.status });
  }) as typeof fetch;
}

const triggers: string[] = [];
setAuthFailureSink((t) => triggers.push(t));

// (1) persistent 401 after a failed refresh → auto-401
triggers.length = 0;
stubFetch([
  { status: 401, body: "unauthorized" },
  { status: 401, body: "still unauthorized" },
]);
{
  const r = await httpRequest({
    method: "GET",
    url: "https://x.test/a",
    reportAuthFailure: true,
    onUnauthorized: async () => ({ Authorization: "Bearer new" }), // refresh "succeeds" but retry still 401
    maxRetries: 0,
  });
  assert(r.status === 401, "http: final status 401");
  assert(
    triggers.length === 1 && triggers[0] === "auto-401",
    `http: persistent 401 → sink auto-401 (got ${triggers.join(",")})`,
  );
}

// (2) 401 recovered by refresh (retry → 200) → NO invalidation
triggers.length = 0;
stubFetch([
  { status: 401, body: "unauthorized" },
  { status: 200, body: "{}" },
]);
{
  const r = await httpRequest({
    method: "GET",
    url: "https://x.test/b",
    reportAuthFailure: true,
    onUnauthorized: async () => ({ Authorization: "Bearer new" }),
    maxRetries: 0,
  });
  assert(r.status === 200, "http: recovered to 200");
  assert(
    triggers.length === 0,
    `http: recovered 401 → no invalidation (got ${triggers.join(",")})`,
  );
}

// (3) 403 scope → auto-403-scope
triggers.length = 0;
stubFetch([{ status: 403, body: '{"error":{"message":"Insufficient client scope"}}' }]);
{
  await httpRequest({
    method: "GET",
    url: "https://x.test/c",
    reportAuthFailure: true,
    maxRetries: 0,
  });
  assert(
    triggers.length === 1 && triggers[0] === "auto-403-scope",
    `http: scope 403 → auto-403-scope (got ${triggers.join(",")})`,
  );
}

// (4) 403 rate-limit → NO invalidation
triggers.length = 0;
stubFetch([{ status: 403, body: "rate limit exceeded" }]);
{
  await httpRequest({
    method: "GET",
    url: "https://x.test/d",
    reportAuthFailure: true,
    maxRetries: 0,
  });
  assert(
    triggers.length === 0,
    `http: rate-limit 403 → no invalidation (got ${triggers.join(",")})`,
  );
}

// (5) reportAuthFailure not set → never invalidates even on 401
triggers.length = 0;
stubFetch([{ status: 401, body: "unauthorized" }]);
{
  await httpRequest({ method: "GET", url: "https://x.test/e", maxRetries: 0 });
  assert(triggers.length === 0, "http: opt-out request never invalidates");
}

// (6) 5xx → retried then surfaced, never invalidates
triggers.length = 0;
stubFetch([{ status: 500, body: "err" }]);
{
  try {
    await httpRequest({
      method: "GET",
      url: "https://x.test/f",
      reportAuthFailure: true,
      maxRetries: 0,
    });
  } catch {
    /* HttpError expected */
  }
  assert(triggers.length === 0, "http: 5xx → no invalidation");
}

setAuthFailureSink(undefined);
globalThis.fetch = realFetch;

process.exit(process.exitCode ?? 0);

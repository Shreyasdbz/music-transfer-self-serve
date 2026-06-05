// Structured logger with mandatory secret redaction per blueprint §12.
//
// Every string going to stdout/stderr, a file, an HTTP response, or an SSE
// payload MUST flow through {@link redact} first. The redaction rules are
// listed in §12 (in order):
//   - HTTP header names: Authorization, Music-User-Token, Set-Cookie, Cookie,
//     X-Apple-Music-User-Token
//   - Body JSON keys (case-insensitive): access_token, refresh_token,
//     developerToken, developer_token, musicUserToken, music_user_token,
//     id_token, code_verifier, state, nonce, code
//   - Anything matching `Bearer <40+chars>`
//   - Anything matching `-----BEGIN .* PRIVATE KEY-----`
//   - The configured APPLE_TEAM_ID and APPLE_KEY_ID values (loaded once here)
//
// Substitution is `<redacted:<kind>>`.

const REDACTED_HEADER_NAMES = new Set([
  "authorization",
  "music-user-token",
  "x-apple-music-user-token",
  "set-cookie",
  "cookie",
]);

const REDACTED_BODY_KEYS = new Set([
  "access_token",
  "refresh_token",
  "developertoken",
  "developer_token",
  "musicusertoken",
  "music_user_token",
  "mut", // wire JSON key actually used by web/musickit.html → /api/auth/apple/callback
  "id_token",
  "code_verifier",
  "state",
  "nonce",
  "code",
]);

// Used by {@link redactUrl} to scrub secrets out of query strings. Per
// blueprint §12, query-string parameters with any of the above body-key names
// must also be redacted before any string reaches stdout/stderr/SSE.
const REDACTED_QUERY_PARAMS = REDACTED_BODY_KEYS;

const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]{40,}/g;
const PRIVATE_KEY_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

// Captured at module init; if not present yet (e.g. logger imported before
// .env is loaded), the values default to never-matching sentinels.
const TEAM_ID = (process.env["APPLE_TEAM_ID"] ?? "").trim();
const KEY_ID = (process.env["APPLE_KEY_ID"] ?? "").trim();

function redactString(s: string): string {
  let out = s.replace(PRIVATE_KEY_RE, "<redacted:private-key>");
  out = out.replace(BEARER_RE, "Bearer <redacted:token>");
  if (TEAM_ID.length >= 6) out = out.split(TEAM_ID).join("<redacted:team-id>");
  if (KEY_ID.length >= 6) out = out.split(KEY_ID).join("<redacted:key-id>");
  return out;
}

/** Redact sensitive query-string parameters from a URL without losing the
 * shape of the URL — useful for logging request URLs without leaking the
 * Spotify OAuth `code` + `state`, refresh tokens, MUTs, etc.
 *
 * Non-URL inputs (relative paths, malformed URLs) are returned with
 * `redactString` applied so we still scrub bearer / key patterns. */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactString(url);
  }
  let mutated = false;
  for (const [key] of parsed.searchParams) {
    if (REDACTED_QUERY_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.set(key, "<redacted:secret>");
      mutated = true;
    }
  }
  return mutated ? redactString(parsed.toString()) : redactString(url);
}

export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const v = Array.isArray(value) ? value.join(", ") : value;
    out[name] = REDACTED_HEADER_NAMES.has(name.toLowerCase())
      ? "<redacted:header>"
      : redactString(v);
  }
  return out;
}

function redactValue(value: unknown, parentKey?: string): unknown {
  if (typeof value === "string") {
    if (parentKey && REDACTED_BODY_KEYS.has(parentKey.toLowerCase())) {
      return "<redacted:secret>";
    }
    return redactString(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, parentKey));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k);
    }
    return out;
  }
  return value;
}

/** Public: redact arbitrary data (string, object, array, primitive) before logging. */
export function redact(input: unknown): unknown {
  return redactValue(input);
}

type Level = "info" | "warn" | "error" | "debug";

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: typeof msg === "string" ? redactString(msg) : msg,
    ...(meta ? { meta: redact(meta) } : {}),
  };
  const text = JSON.stringify(line);
  if (level === "error" || level === "warn") {
    process.stderr.write(text + "\n");
  } else {
    process.stdout.write(text + "\n");
  }
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
};

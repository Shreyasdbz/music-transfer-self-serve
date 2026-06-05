// Load + validate environment per blueprint §4, §10.
// Failing config returns a tagged error rather than throwing — `src/server.ts`
// formats it into an actionable startup message; `doctor`'s `env` check reads
// the same predicate.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { config as loadDotenv } from "dotenv";

loadDotenv();

const ROOT = resolve(import.meta.dirname, "..");
export const DATA_DIR = resolve(ROOT, "data");
export const SECRETS_DIR = resolve(ROOT, "secrets");
// The built Vite+Solid client (../web/dist relative to server/). In dev the
// client is served by Vite (which proxies /api + /auth here); in prod Hono
// serves this directory. Run `npm run build:web` to produce it.
export const WEB_DIR = resolve(ROOT, "..", "web", "dist");
export const LEDGER_PATH = resolve(DATA_DIR, "ledger.sqlite");
export const TOKENS_PATH = resolve(DATA_DIR, "tokens.json");

// ── Network surface (env-driven; loopback defaults = v1 behavior) ─────────
// Blueprint §15 amendment A1: the v1 "127.0.0.1-only" rule becomes env-driven
// so the tool is self-hostable behind an HTTPS reverse proxy. With no env set,
// these resolve to the original loopback values (no regression).
function csv(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Address the server LISTENS on. Default 127.0.0.1; set 0.0.0.0 ONLY behind a
 * trusted reverse proxy. */
export const HTTP_HOST = process.env["BIND_HOST"]?.trim() || "127.0.0.1";
function parsePort(raw: string | undefined): number {
  const p = Number(raw?.trim() || "8888");
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`PORT must be an integer 1-65535, got: ${JSON.stringify(raw)} (see .env.example)`);
  }
  return p;
}
export const HTTP_PORT = parsePort(process.env["PORT"]);

/** The externally-visible origin (what the browser sees). Behind a proxy this
 * is e.g. https://music.example.com. Default = loopback. */
export const PUBLIC_ORIGIN = (process.env["PUBLIC_ORIGIN"]?.trim() || `http://127.0.0.1:${HTTP_PORT}`).replace(/\/+$/, "");
/** Kept as an alias for logging / the redirect URI base. */
export const HTTP_ORIGIN = PUBLIC_ORIGIN;

/** Origins accepted on state-changing POSTs (§11.0). Default = [PUBLIC_ORIGIN]. */
export const ALLOWED_ORIGINS: readonly string[] = csv(process.env["ALLOWED_ORIGINS"]).length
  ? csv(process.env["ALLOWED_ORIGINS"])
  : [PUBLIC_ORIGIN];
/** Host headers accepted on EVERY route (DNS-rebinding defense). Default = the
 * host of PUBLIC_ORIGIN. */
export const ALLOWED_HOSTS: readonly string[] = csv(process.env["ALLOWED_HOSTS"]).length
  ? csv(process.env["ALLOWED_HOSTS"])
  : [new URL(PUBLIC_ORIGIN).host];

/** Optional access seam (§15 A3): when set, the instance requires a signed
 * session cookie (obtained by submitting this token once). Empty = open
 * (loopback is the protection for a local single-owner instance). */
export const INSTANCE_ACCESS_TOKEN = process.env["INSTANCE_ACCESS_TOKEN"]?.trim() || "";
/** HMAC secret for the session cookie. Default = random per server start
 * (sessions don't survive a restart unless the operator sets this). */
export const SESSION_SECRET = process.env["SESSION_SECRET"]?.trim() || randomBytes(32).toString("hex");

/** Spotify redirect URI — derived from PUBLIC_ORIGIN; MUST match byte-for-byte
 * across .env, the Spotify Dashboard, /api/auth/spotify/start, and the callback
 * (blueprint §4 + Phase 2 AC #2). */
export const SPOTIFY_REDIRECT_URI_EXPECTED = `${PUBLIC_ORIGIN}/auth/spotify/callback`;

export interface AppConfig {
  readonly spotifyClientId: string;
  readonly spotifyRedirectUri: string;
  readonly appleTeamId: string;
  readonly appleKeyId: string;
  readonly applePrivateKeyPath: string;
  readonly appleMusicKitAppName: string;
}

export interface EnvCheckResult {
  readonly ok: boolean;
  readonly missingKeys: readonly string[];
  readonly keyFileReadable: boolean;
  readonly redirectUriMatches: boolean;
}

const REQUIRED_KEYS = [
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_REDIRECT_URI",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY_PATH",
] as const;

export function checkEnv(): EnvCheckResult {
  const missing: string[] = [];
  for (const k of REQUIRED_KEYS) {
    if (!process.env[k]?.trim()) missing.push(k);
  }
  const keyPath = process.env["APPLE_PRIVATE_KEY_PATH"];
  let keyFileReadable = false;
  if (keyPath) {
    try {
      readFileSync(resolve(ROOT, keyPath));
      keyFileReadable = true;
    } catch {
      keyFileReadable = false;
    }
  }
  const redirectUriMatches =
    process.env["SPOTIFY_REDIRECT_URI"] === SPOTIFY_REDIRECT_URI_EXPECTED;
  return {
    ok: missing.length === 0 && keyFileReadable && redirectUriMatches,
    missingKeys: missing,
    keyFileReadable,
    redirectUriMatches,
  };
}

// (The unified `loadConfig()` was removed — every call site now uses the
// platform-scoped `loadSpotifyConfig()` or `loadAppleConfig()` below, so a
// missing Apple key never blocks a Spotify-only code path and vice versa.
// `AppConfig` is retained as a re-export shape for anything that wants the
// full union; today no code references it.)

export interface SpotifyConfig {
  readonly spotifyClientId: string;
  readonly spotifyRedirectUri: string;
}

export interface AppleConfig {
  readonly appleTeamId: string;
  readonly appleKeyId: string;
  readonly applePrivateKeyPath: string;
  readonly appleMusicKitAppName: string;
}

/** Apple-only slice — usable independent of Spotify state. */
export function loadAppleConfig(): AppleConfig {
  const missing: string[] = [];
  for (const k of ["APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY_PATH"] as const) {
    if (!process.env[k]?.trim()) missing.push(k);
  }
  if (missing.length > 0) {
    throw new Error(`Missing Apple env vars: ${missing.join(", ")} (see .env.example)`);
  }
  const keyPath = resolve(ROOT, process.env["APPLE_PRIVATE_KEY_PATH"]!);
  try {
    readFileSync(keyPath);
  } catch {
    throw new Error(`Apple private key at ${process.env["APPLE_PRIVATE_KEY_PATH"]} not readable`);
  }
  return {
    appleTeamId: process.env["APPLE_TEAM_ID"]!,
    appleKeyId: process.env["APPLE_KEY_ID"]!,
    applePrivateKeyPath: keyPath,
    appleMusicKitAppName: process.env["APPLE_MUSICKIT_APP_NAME"] ?? "music-transfer-self-serve",
  };
}

/** Spotify-only slice — usable between ⏸B and ⏸C when Apple creds are absent. */
export function loadSpotifyConfig(): SpotifyConfig {
  const missing: string[] = [];
  for (const k of ["SPOTIFY_CLIENT_ID", "SPOTIFY_REDIRECT_URI"] as const) {
    if (!process.env[k]?.trim()) missing.push(k);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing Spotify env vars: ${missing.join(", ")} (see .env.example)`,
    );
  }
  if (process.env["SPOTIFY_REDIRECT_URI"] !== SPOTIFY_REDIRECT_URI_EXPECTED) {
    throw new Error(
      `SPOTIFY_REDIRECT_URI must equal "${SPOTIFY_REDIRECT_URI_EXPECTED}" ` +
        `(see blueprint §4 / Phase 2 AC #2)`,
    );
  }
  return {
    spotifyClientId: process.env["SPOTIFY_CLIENT_ID"]!,
    spotifyRedirectUri: process.env["SPOTIFY_REDIRECT_URI"]!,
  };
}

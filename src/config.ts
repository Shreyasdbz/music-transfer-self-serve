// Load + validate environment per blueprint §4, §10.
// Failing config returns a tagged error rather than throwing — `src/server.ts`
// formats it into an actionable startup message; `doctor`'s `env` check reads
// the same predicate.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv();

const ROOT = resolve(import.meta.dirname, "..");
export const DATA_DIR = resolve(ROOT, "data");
export const SECRETS_DIR = resolve(ROOT, "secrets");
export const WEB_DIR = resolve(ROOT, "web");
export const LEDGER_PATH = resolve(DATA_DIR, "ledger.sqlite");
export const TOKENS_PATH = resolve(DATA_DIR, "tokens.json");

export const HTTP_HOST = "127.0.0.1";
export const HTTP_PORT = 8888;
export const HTTP_ORIGIN = `http://${HTTP_HOST}:${HTTP_PORT}`;
export const HTTP_HOST_HEADER = `${HTTP_HOST}:${HTTP_PORT}`;

/** Spotify redirect URI — MUST match byte-for-byte across .env, .env.example,
 * the Spotify Dashboard, /api/auth/spotify/start, and /auth/spotify/callback
 * (blueprint §4 + Phase 2 AC #2). */
export const SPOTIFY_REDIRECT_URI_EXPECTED = `${HTTP_ORIGIN}/auth/spotify/callback`;

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

/** Read the full config. Throws if required keys are missing — callers that
 * want a soft check (e.g. preflight) use {@link checkEnv} instead. */
export function loadConfig(): AppConfig {
  const r = checkEnv();
  if (r.missingKeys.length > 0) {
    throw new Error(
      `Missing required env vars: ${r.missingKeys.join(", ")} (see .env.example)`,
    );
  }
  if (!r.redirectUriMatches) {
    throw new Error(
      `SPOTIFY_REDIRECT_URI must equal "${SPOTIFY_REDIRECT_URI_EXPECTED}" ` +
        `(see blueprint §4 / Phase 2 AC #2)`,
    );
  }
  return {
    spotifyClientId: process.env["SPOTIFY_CLIENT_ID"]!,
    spotifyRedirectUri: process.env["SPOTIFY_REDIRECT_URI"]!,
    appleTeamId: process.env["APPLE_TEAM_ID"]!,
    appleKeyId: process.env["APPLE_KEY_ID"]!,
    applePrivateKeyPath: resolve(ROOT, process.env["APPLE_PRIVATE_KEY_PATH"]!),
    appleMusicKitAppName:
      process.env["APPLE_MUSICKIT_APP_NAME"] ?? "music-transfer-self-serve",
  };
}

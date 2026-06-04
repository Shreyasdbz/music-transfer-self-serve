// Apple Music developer-token signing + popup-nonce store + MUT storage
// per blueprint §5.2 + §11.0.
//
// Two distinct tokens:
//   - **Long-lived developer token** (180 days, server-side only).
//     Used in every server-to-Apple API call. Cached in memory; regenerated
//     automatically when within 7 days of expiry. Signed from the .p8.
//   - **Short-lived developer token** (10 minutes, browser-exposed).
//     Minted per `/api/auth/apple/start` request. The popup loads MusicKit JS
//     and configures it with this token, calls `authorize()`, posts the
//     resulting Music-User-Token (MUT) back to `/api/auth/apple/callback`.
//     Even if a malicious page somehow captures this token, it auto-expires
//     in 10 min, vs the 180-day token which never leaves the server.

import { readFileSync, chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { loadAppleConfig } from "../config.js";
import { log } from "../util/log.js";
import { readTokens, updateAppleTokens, type AppleTokens } from "./tokens.js";

const LONG_LIFE_DAYS = 180;
const LONG_LIFE_REFRESH_THRESHOLD_DAYS = 7;
const SHORT_LIFE_SECONDS = 600; // 10 minutes
const NONCE_TTL_MS = 10 * 60 * 1000;
const NONCE_SWEEP_INTERVAL_MS = 60 * 1000;
// Same defensive bound rationale as Spotify's state store (auth/spotify.ts).
const NONCE_STORE_MAX = 10_000;

interface NonceEntry {
  created_at: number;
}

const nonceStore = new Map<string, NonceEntry>();
let nonceSweeper: NodeJS.Timeout | undefined;

/** Walk the nonce store and delete any entry older than NONCE_TTL_MS. */
function sweepExpiredNonces(now = Date.now()): number {
  let purged = 0;
  for (const [nonce, entry] of nonceStore.entries()) {
    if (now - entry.created_at > NONCE_TTL_MS) {
      nonceStore.delete(nonce);
      purged++;
    }
  }
  if (purged > 0) log.debug("apple.nonce_sweep_purged", { purged });
  return purged;
}

export function startNonceSweeper(): void {
  if (nonceSweeper) return;
  nonceSweeper = setInterval(() => {
    sweepExpiredNonces();
  }, NONCE_SWEEP_INTERVAL_MS);
  nonceSweeper.unref?.();
}

export function stopNonceSweeper(): void {
  if (nonceSweeper) {
    clearInterval(nonceSweeper);
    nonceSweeper = undefined;
  }
}

// ── Private key loading ────────────────────────────────────────────────────

// Cache keyed on the .p8 file's path + mtime so an in-place key rotation
// (user replaces the .p8 with a new key from the Apple Developer dashboard)
// is picked up on the next call without a server restart. The path part of
// the key also invalidates if APPLE_PRIVATE_KEY_PATH changes mid-process.
interface PrivateKeyCache {
  key: string;
  cacheKey: string;
}
let cachedPrivateKey: PrivateKeyCache | undefined;

function loadPrivateKey(): string {
  const cfg = loadAppleConfig();
  // Enforce 0700 on secrets/ + 0600 on the .p8 per §12 ("Apple's downloaded
  // .p8 is 0644 by default; chmod 0600 it on first read, or refuse to run if
  // it's group/world readable").
  const secretsDir = dirname(cfg.applePrivateKeyPath);
  try {
    const dst = statSync(secretsDir);
    if ((dst.mode & 0o077) !== 0) {
      try {
        chmodSync(secretsDir, 0o700);
        log.info("apple.secrets_dir_perms_tightened");
      } catch (err) {
        // The .p8 itself is the load-bearing perm, so don't throw. But do
        // surface the failure clearly — a group/world-readable secrets/ dir
        // is a §12 invariant violation worth flagging in logs.
        log.warn("apple.secrets_dir_chmod_failed", {
          path: secretsDir,
          message: (err as Error).message,
        });
      }
    }
  } catch {
    // statSync may fail on non-POSIX FS; the read below is what really matters.
  }
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(cfg.applePrivateKeyPath);
    if ((stat.mode & 0o077) !== 0) {
      try {
        chmodSync(cfg.applePrivateKeyPath, 0o600);
        log.info("apple.private_key_perms_tightened");
        stat = statSync(cfg.applePrivateKeyPath); // re-stat for the cache key
      } catch (err) {
        throw new Error(
          `Apple .p8 at ${cfg.applePrivateKeyPath} is group/world-readable and chmod 0600 failed: ${(err as Error).message}`,
        );
      }
    }
  } catch (err) {
    if (!(err as { code?: string }).code) throw err;
    // statSync failure already raised in loadAppleConfig — re-fall through.
  }

  // Cache key combines path + mtimeMs (millisecond precision is plenty for
  // detecting a manual key rotation). Rotating the .p8 in place changes
  // mtimeMs → cache miss → fresh read.
  const cacheKey = `${cfg.applePrivateKeyPath}@${stat?.mtimeMs ?? 0}`;
  if (cachedPrivateKey && cachedPrivateKey.cacheKey === cacheKey) {
    return cachedPrivateKey.key;
  }
  const key = readFileSync(cfg.applePrivateKeyPath, "utf8");
  cachedPrivateKey = { key, cacheKey };
  // Also invalidate the long-lived dev token cache so the next call signs
  // with the new key material rather than the previously cached JWT.
  longTokenCache = undefined;
  return key;
}

// ── Token signing ──────────────────────────────────────────────────────────

interface LongTokenCache {
  token: string;
  exp_ms: number;
}
let longTokenCache: LongTokenCache | undefined;

function signToken(expiresInSec: number): string {
  const cfg = loadAppleConfig();
  const pk = loadPrivateKey();
  // The Apple spec defines `iss` (Team ID), `exp`, and `kid` in the header.
  // `jsonwebtoken` puts iss/exp in the payload + kid in the header.
  return jwt.sign({}, pk, {
    algorithm: "ES256",
    expiresIn: expiresInSec,
    issuer: cfg.appleTeamId,
    header: { alg: "ES256", kid: cfg.appleKeyId },
  });
}

/** The 180-day server-side token. Cached and auto-regenerated within 7d of expiry. */
export function getLongLivedDevToken(): string {
  const now = Date.now();
  if (
    longTokenCache &&
    longTokenCache.exp_ms - now > LONG_LIFE_REFRESH_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  ) {
    return longTokenCache.token;
  }
  const expiresInSec = LONG_LIFE_DAYS * 24 * 60 * 60;
  const token = signToken(expiresInSec);
  longTokenCache = { token, exp_ms: now + expiresInSec * 1000 };
  log.info("apple.dev_token_signed", { lifetime_days: LONG_LIFE_DAYS });
  return token;
}

/** A short-lived (10-min) token minted just for one popup. */
export function mintPopupDevToken(): string {
  return signToken(SHORT_LIFE_SECONDS);
}

// ── Popup nonce lifecycle ──────────────────────────────────────────────────

export interface PopupStart {
  developerToken: string;
  nonce: string;
  appName: string;
}

export function buildPopupStart(): PopupStart {
  const cfg = loadAppleConfig();
  const developerToken = mintPopupDevToken();
  const nonce = randomBytes(32).toString("base64url");
  // Defensive cap — mirror Spotify's state-store eviction (auth/spotify.ts).
  if (nonceStore.size >= NONCE_STORE_MAX) {
    sweepExpiredNonces();
    while (nonceStore.size >= NONCE_STORE_MAX) {
      const oldest = nonceStore.keys().next().value;
      if (!oldest) break;
      nonceStore.delete(oldest);
    }
    log.warn("apple.nonce_store_pressure_evicted", { size: nonceStore.size });
  }
  nonceStore.set(nonce, { created_at: Date.now() });
  return { developerToken, nonce, appName: cfg.appleMusicKitAppName };
}

export type CallbackResult =
  | { kind: "ok" }
  | { kind: "nonce_unknown" }
  | { kind: "nonce_expired" }
  | { kind: "mut_missing" };

/** Validate the nonce, persist the MUT, consume the nonce. */
export function handleCallback(nonceParam: string, mut: string): CallbackResult {
  if (!mut || mut.length < 1) return { kind: "mut_missing" };
  const entry = nonceStore.get(nonceParam);
  if (!entry) return { kind: "nonce_unknown" };
  if (Date.now() - entry.created_at > NONCE_TTL_MS) {
    nonceStore.delete(nonceParam);
    return { kind: "nonce_expired" };
  }
  nonceStore.delete(nonceParam);
  const stored: AppleTokens = { mut, captured_at: Date.now() };
  updateAppleTokens(stored);
  // The new MUT may belong to a different Apple account (different
  // storefront — US → JP, etc.); the storefront cache in clients/apple.ts
  // is keyed on MUT prefix so a different MUT auto-invalidates on the next
  // getStorefront() call. No explicit invalidation needed here, but the
  // invariant is documented at the cache definition site.
  return { kind: "ok" };
}

export function getMut(): string {
  const cur = readTokens().apple;
  if (!cur) throw new Error("apple_not_connected");
  return cur.mut;
}

export function getConnectedState(): { connected: boolean; captured_at?: number } {
  const cur = readTokens().apple;
  if (!cur) return { connected: false };
  return { connected: true, captured_at: cur.captured_at };
}

// ── Test-only hooks ────────────────────────────────────────────────────────

export const __test = {
  injectNonce: (nonce: string, created_at: number): void => {
    nonceStore.set(nonce, { created_at });
  },
  hasNonce: (nonce: string): boolean => nonceStore.has(nonce),
  clear: (): void => {
    nonceStore.clear();
    longTokenCache = undefined;
    cachedPrivateKey = undefined;
  },
  // Cache-key form: "<path>@<mtimeNs>". Test verifies the rotation behavior
  // by mutating the cached entry directly.
  getPrivateKeyCacheKey: (): string | undefined => cachedPrivateKey?.cacheKey,
  size: (): number => nonceStore.size,
  runSweep: (now?: number): number => sweepExpiredNonces(now),
  popupTtlSeconds: SHORT_LIFE_SECONDS,
};

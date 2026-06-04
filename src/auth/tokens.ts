// Persistent token store at data/tokens.json (gitignored, 0600).
// Schema is intentionally permissive — Spotify and Apple sides each own their
// slice. Writes are atomic via a temp-file rename to avoid torn reads on crash.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DATA_DIR, TOKENS_PATH } from "../config.js";

export interface SpotifyTokens {
  /** access token (typically expires in 3600s) */
  readonly access_token: string;
  /** long-lived; persists until revoked */
  readonly refresh_token: string;
  /** epoch ms when access_token expires */
  readonly expires_at: number;
  /** space-separated scope string captured from the OAuth response */
  readonly scope: string;
  readonly token_type: "Bearer";
}

export interface AppleTokens {
  readonly mut: string;
  /** epoch ms when MUT was captured (no Apple-side expiry signal in v1) */
  readonly captured_at: number;
}

export interface TokenStore {
  spotify?: SpotifyTokens;
  apple?: AppleTokens;
}

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(DATA_DIR, 0o700);
  } catch {
    /* non-POSIX no-op */
  }
}

export function readTokens(): TokenStore {
  if (!existsSync(TOKENS_PATH)) return {};
  try {
    const text = readFileSync(TOKENS_PATH, "utf8");
    return JSON.parse(text) as TokenStore;
  } catch {
    return {};
  }
}

function writeAtomic(path: string, content: string): void {
  ensureDir();
  const tmp = `${path}.tmp.${process.pid}.${Math.floor(Math.random() * 1e9)}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* non-POSIX no-op */
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* non-POSIX no-op */
  }
  // Touch parent dir to be safe.
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    /* non-POSIX no-op */
  }
}

export function writeTokens(store: TokenStore): void {
  writeAtomic(TOKENS_PATH, JSON.stringify(store, null, 2));
}

export function updateSpotifyTokens(tokens: SpotifyTokens): void {
  const cur = readTokens();
  writeTokens({ ...cur, spotify: tokens });
}

export function updateAppleTokens(tokens: AppleTokens): void {
  const cur = readTokens();
  writeTokens({ ...cur, apple: tokens });
}

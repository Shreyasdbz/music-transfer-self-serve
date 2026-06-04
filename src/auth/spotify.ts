// Spotify Authorization Code with PKCE per blueprint §5.1 + §11.0.
//
// Surface:
//   - {@link buildAuthorizeUrl}: generates state + code_verifier, stashes them
//     in an in-memory map (10-min TTL, swept every 60s), returns the URL the
//     UI opens in a popup. Per-server-start store.
//   - {@link handleCallback}: validates state, exchanges code for tokens,
//     persists `{access, refresh, expires_at, scope}` to tokens.json.
//   - {@link getAccessToken}: returns a valid access token, refreshing on the
//     fly if it's within 60s of expiry or already expired.
//   - {@link startStateSweeper} / {@link stopStateSweeper}: lifecycle for the
//     60s sweep.

import { createHash, randomBytes } from "node:crypto";
import { loadSpotifyConfig, SPOTIFY_REDIRECT_URI_EXPECTED } from "../config.js";
import { httpJson } from "../util/http.js";
import { log } from "../util/log.js";
import {
  readTokens,
  updateSpotifyTokens,
  type SpotifyTokens,
} from "./tokens.js";

export const REQUIRED_SPOTIFY_SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-library-modify",
] as const;

const STATE_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const REFRESH_LEEWAY_MS = 60 * 1000;

interface StateEntry {
  code_verifier: string;
  created_at: number;
}

const stateStore = new Map<string, StateEntry>();
let sweeper: NodeJS.Timeout | undefined;

/** Walk the state store and delete any entry older than STATE_TTL_MS.
 * Returns the count purged. Called by the 60s interval and by the AC test. */
function sweepExpiredStates(now = Date.now()): number {
  let purged = 0;
  for (const [state, entry] of stateStore.entries()) {
    if (now - entry.created_at > STATE_TTL_MS) {
      stateStore.delete(state);
      purged++;
    }
  }
  if (purged > 0) log.debug("spotify.state_sweep_purged", { purged });
  return purged;
}

export function startStateSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    sweepExpiredStates();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

export function stopStateSweeper(): void {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function genVerifier(): string {
  // 96 bytes → 128-char base64url, well within RFC 7636's 43–128 range.
  return base64url(randomBytes(96));
}

function challenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export interface AuthorizeStart {
  readonly authorizeUrl: string;
}

export function buildAuthorizeUrl(): AuthorizeStart {
  const cfg = loadSpotifyConfig();
  const state = base64url(randomBytes(32));
  const code_verifier = genVerifier();
  const code_challenge = challenge(code_verifier);

  stateStore.set(state, { code_verifier, created_at: Date.now() });

  const params = new URLSearchParams({
    client_id: cfg.spotifyClientId,
    response_type: "code",
    redirect_uri: cfg.spotifyRedirectUri,
    code_challenge_method: "S256",
    code_challenge,
    state,
    scope: REQUIRED_SPOTIFY_SCOPES.join(" "),
  });
  return {
    authorizeUrl: `https://accounts.spotify.com/authorize?${params.toString()}`,
  };
}

export type CallbackResult =
  | { kind: "ok"; scope: string }
  | { kind: "state_unknown" }
  | { kind: "state_expired" }
  | { kind: "exchange_failed"; status: number };

interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export async function handleCallback(stateParam: string, code: string): Promise<CallbackResult> {
  const entry = stateStore.get(stateParam);
  if (!entry) return { kind: "state_unknown" };
  if (Date.now() - entry.created_at > STATE_TTL_MS) {
    stateStore.delete(stateParam);
    return { kind: "state_expired" };
  }
  // Consume on success path below; keep entry for retry on transient errors? No —
  // OAuth `code` is single-use anyway. Delete now.
  stateStore.delete(stateParam);

  const cfg = loadSpotifyConfig();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.spotifyRedirectUri,
    client_id: cfg.spotifyClientId,
    code_verifier: entry.code_verifier,
  });
  try {
    const tok = await httpJson<TokenResponse>({
      method: "POST",
      url: "https://accounts.spotify.com/api/token",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    persistTokens(tok);
    return { kind: "ok", scope: tok.scope };
  } catch (err) {
    const e = err as { status?: number };
    log.warn("spotify.exchange_failed", { status: e.status });
    return { kind: "exchange_failed", status: e.status ?? 0 };
  }
}

function persistTokens(tok: TokenResponse): void {
  const stored: SpotifyTokens = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + tok.expires_in * 1000,
    scope: tok.scope,
    token_type: "Bearer",
  };
  updateSpotifyTokens(stored);
}

async function refreshAccessToken(current: SpotifyTokens): Promise<SpotifyTokens> {
  const cfg = loadSpotifyConfig();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refresh_token,
    client_id: cfg.spotifyClientId,
  });
  const tok = await httpJson<Partial<TokenResponse> & Pick<TokenResponse, "access_token" | "expires_in">>({
    method: "POST",
    url: "https://accounts.spotify.com/api/token",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  // Spotify may omit refresh_token on refresh — keep the old one in that case.
  const refresh_token = tok.refresh_token ?? current.refresh_token;
  const scope = tok.scope ?? current.scope;
  const next: SpotifyTokens = {
    access_token: tok.access_token,
    refresh_token,
    expires_at: Date.now() + tok.expires_in * 1000,
    scope,
    token_type: "Bearer",
  };
  updateSpotifyTokens(next);
  return next;
}

/** Returns a non-expired Spotify access token, refreshing if needed. Throws
 * if no tokens are stored (caller's job to redirect to Connect). */
export async function getAccessToken(): Promise<string> {
  const store = readTokens();
  const cur = store.spotify;
  if (!cur) throw new Error("spotify_not_connected");
  if (Date.now() < cur.expires_at - REFRESH_LEEWAY_MS) return cur.access_token;
  const next = await refreshAccessToken(cur);
  return next.access_token;
}

export function getConnectedState(): { connected: boolean; expires_at?: number; scope?: string } {
  const cur = readTokens().spotify;
  if (!cur) return { connected: false };
  return { connected: true, expires_at: cur.expires_at, scope: cur.scope };
}

// Test-only hooks
export const __test = {
  injectState: (state: string, code_verifier: string, created_at: number): void => {
    stateStore.set(state, { code_verifier, created_at });
  },
  hasState: (state: string): boolean => stateStore.has(state),
  clear: (): void => stateStore.clear(),
  size: (): number => stateStore.size,
  runSweep: (now?: number): number => sweepExpiredStates(now),
};

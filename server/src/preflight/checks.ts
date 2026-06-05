// The 10 preflight checks (blueprint §11.1) + their §12 detail allow-lists.
//
// Each check returns a CheckResult. The runner (runner.ts) is responsible for
// ordering, skip propagation, persistence, and SSE emission — checks here are
// the leaf logic only.
//
// §12: the `detail` JSON for each check has a FIXED allow-list of keys; the
// runner enforces "no extra fields" via `validateDetail` before insert.
// Failure rows additionally carry { error_class, error_message_safe } where
// error_message_safe is the platform message AFTER redaction.

import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { checkEnv, loadAppleConfig } from "../config.js";
import { redact } from "../util/log.js";
import { readTokens } from "../auth/tokens.js";
import { getAccessToken, REQUIRED_SPOTIFY_SCOPES } from "../auth/spotify.js";
import { getLongLivedDevToken, getMut } from "../auth/apple.js";
import { getMe, searchTracks } from "../clients/spotify.js";
import {
  getStorefront,
  headLibraryPlaylists,
  getTopChartSongs,
  searchByIsrc,
  clearStorefrontCache,
} from "../clients/apple.js";
import { appleCatalogToCanonical, isValidatedCandidate } from "../match/matcher.js";

export type CheckName =
  | "env"
  | "spotify_token"
  | "spotify_scopes"
  | "spotify_me"
  | "spotify_search"
  | "apple_dev_token"
  | "apple_mut"
  | "apple_storefront"
  | "apple_library_read"
  | "apple_isrc_lookup";

export type CheckGroup = "env" | "spotify" | "apple";

export type CheckResult =
  | { status: "pass"; detail: Record<string, unknown> }
  | { status: "fail"; detail: Record<string, unknown> }
  | { status: "skip"; detail: Record<string, unknown> };

export interface CheckDef {
  readonly name: CheckName;
  readonly group: CheckGroup;
  /** True for the group's gating auth check — if it fails, the rest of the
   * group is skipped (§11.1). */
  readonly isGroupGate: boolean;
  readonly run: () => Promise<CheckResult>;
}

// ── §12 detail allow-lists ───────────────────────────────────────────────

export const DETAIL_ALLOWLIST: Record<CheckName, readonly string[]> = {
  env: ["missing_keys", "key_file_readable"],
  spotify_token: ["source", "expires_in_seconds"],
  spotify_scopes: ["missing_scopes", "granted_count"],
  spotify_me: ["user_id_hash"],
  spotify_search: ["results_returned"],
  apple_dev_token: ["alg", "exp_days_remaining", "signed"],
  apple_mut: ["accepted"],
  apple_storefront: ["storefront"],
  apple_library_read: ["playlists_returned"],
  apple_isrc_lookup: ["fixture_isrc", "validated_candidates"],
};

const FAILURE_EXTRA_KEYS = ["error_class", "error_message_safe"] as const;

/** Enforce "no extra fields" on a check's detail object before persistence.
 * Failure rows may additionally carry error_class / error_message_safe.
 * Throws if an unexpected key is present — a developer error, caught in tests
 * rather than silently leaking an unredacted field. */
export function validateDetail(name: CheckName, status: "pass" | "fail" | "skip", detail: Record<string, unknown>): void {
  const allowed = new Set<string>(DETAIL_ALLOWLIST[name]);
  if (status === "fail") for (const k of FAILURE_EXTRA_KEYS) allowed.add(k);
  if (status === "skip") allowed.add("reason");
  for (const k of Object.keys(detail)) {
    if (!allowed.has(k)) {
      throw new Error(`detail for "${name}" (${status}) has disallowed key "${k}" (§12 allow-list)`);
    }
  }
}

/** Build a redaction-safe failure detail from a thrown error. */
export function failureDetail(err: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const e = err as { name?: string; message?: string; status?: number };
  const cls = e.name || (e.status ? `http_${e.status}` : "Error");
  const msgRaw = e.message ?? String(err);
  return {
    ...extra,
    error_class: cls,
    error_message_safe: String(redact(msgRaw)),
  };
}

// ── Checks ────────────────────────────────────────────────────────────────

const REFRESH_LEEWAY_MS = 60 * 1000;

async function checkEnvFn(): Promise<CheckResult> {
  const r = checkEnv();
  const detail = { missing_keys: [...r.missingKeys], key_file_readable: r.keyFileReadable };
  // env passes iff no missing keys AND the .p8 is readable (redirect-URI
  // mismatch is a separate Phase-2 concern, not part of this allow-list).
  const ok = r.missingKeys.length === 0 && r.keyFileReadable;
  return ok ? { status: "pass", detail } : { status: "fail", detail };
}

async function checkSpotifyToken(): Promise<CheckResult> {
  const cur = readTokens().spotify;
  if (!cur) {
    return { status: "fail", detail: failureDetail(new Error("spotify_not_connected — click Connect Spotify")) };
  }
  const now = Date.now();
  if (now < cur.expires_at - REFRESH_LEEWAY_MS) {
    return { status: "pass", detail: { source: "fresh", expires_in_seconds: Math.round((cur.expires_at - now) / 1000) } };
  }
  // Expired/near-expiry → force a refresh and report the refreshed path.
  await getAccessToken();
  const next = readTokens().spotify;
  if (!next) return { status: "fail", detail: failureDetail(new Error("refresh lost tokens")) };
  return { status: "pass", detail: { source: "refreshed", expires_in_seconds: Math.round((next.expires_at - Date.now()) / 1000) } };
}

async function checkSpotifyScopes(): Promise<CheckResult> {
  const cur = readTokens().spotify;
  if (!cur) return { status: "fail", detail: failureDetail(new Error("spotify_not_connected")) };
  const granted = new Set(cur.scope.split(/\s+/).filter(Boolean));
  const missing = REQUIRED_SPOTIFY_SCOPES.filter((s) => !granted.has(s));
  const detail = { missing_scopes: missing, granted_count: granted.size };
  if (missing.length > 0) {
    return {
      status: "fail",
      detail: {
        ...detail,
        error_class: "missing_scopes",
        error_message_safe: `Missing scopes: ${missing.join(", ")}. Re-Connect Spotify to re-consent.`,
      },
    };
  }
  return { status: "pass", detail };
}

async function checkSpotifyMe(): Promise<CheckResult> {
  try {
    const me = await getMe();
    const hash = createHash("sha256").update(me.id).digest("hex").slice(0, 12);
    return { status: "pass", detail: { user_id_hash: hash } };
  } catch (err) {
    return { status: "fail", detail: failureDetail(err) };
  }
}

async function checkSpotifySearch(): Promise<CheckResult> {
  try {
    const results = await searchTracks("a", 1);
    const n = results.length;
    if (n < 1) return { status: "fail", detail: { results_returned: 0 } };
    return { status: "pass", detail: { results_returned: n } };
  } catch (err) {
    return { status: "fail", detail: failureDetail(err, { results_returned: 0 }) };
  }
}

async function checkAppleDevToken(): Promise<CheckResult> {
  try {
    const token = getLongLivedDevToken(); // signs + caches; regenerates near expiry
    const decoded = jwt.decode(token, { complete: true });
    const alg = decoded?.header?.alg;
    const kid = decoded?.header?.kid;
    const payload = decoded?.payload as { iss?: string; exp?: number } | undefined;
    const iss = payload?.iss;
    const exp = payload?.exp;
    // §11.1: decode locally to confirm iss, kid, and exp are sane. We verify
    // iss/kid are present (and match the configured Team/Key ID), but we do
    // NOT put them in `detail` — they ARE the Team ID / Key ID, which §12
    // forbids surfacing.
    const cfg = loadAppleConfig();
    const issOk = iss === cfg.appleTeamId;
    const kidOk = kid === cfg.appleKeyId;
    if (alg !== "ES256" || !exp || !issOk || !kidOk) {
      return { status: "fail", detail: { alg: "ES256", exp_days_remaining: 0, signed: false } };
    }
    const days = Math.floor((exp * 1000 - Date.now()) / (24 * 60 * 60 * 1000));
    return { status: "pass", detail: { alg: "ES256", exp_days_remaining: days, signed: true } };
  } catch (err) {
    return { status: "fail", detail: failureDetail(err, { alg: "ES256", exp_days_remaining: 0, signed: false }) };
  }
}

async function checkAppleMut(): Promise<CheckResult> {
  try {
    getMut(); // throws if not connected
    // A trivial authorized call proves the MUT is accepted.
    clearStorefrontCache();
    await getStorefront();
    return { status: "pass", detail: { accepted: true } };
  } catch (err) {
    return { status: "fail", detail: failureDetail(err, { accepted: false }) };
  }
}

async function checkAppleStorefront(): Promise<CheckResult> {
  try {
    // Clear the cache first so this check genuinely exercises the
    // `/v1/me/storefront` endpoint rather than returning the value the
    // `apple_mut` check warmed a moment earlier (the two checks run in the
    // same Apple group). This is the §11.1 storefront-cache warm point for the
    // rest of the session.
    clearStorefrontCache();
    const sf = await getStorefront();
    return { status: "pass", detail: { storefront: sf } };
  } catch (err) {
    return { status: "fail", detail: failureDetail(err) };
  }
}

async function checkAppleLibraryRead(): Promise<CheckResult> {
  try {
    const n = await headLibraryPlaylists(1);
    return { status: "pass", detail: { playlists_returned: n } };
  } catch (err) {
    return { status: "fail", detail: failureDetail(err) };
  }
}

async function checkAppleIsrcLookup(): Promise<CheckResult> {
  try {
    const chart = await getTopChartSongs(1);
    const fixture = chart[0]?.attributes.isrc;
    if (!fixture) {
      return { status: "skip", detail: { reason: "storefront top chart returned no song with an ISRC" } };
    }
    const found = await searchByIsrc([fixture]);
    const validated = found.map(appleCatalogToCanonical).filter(isValidatedCandidate).length;
    if (validated < 1) {
      return {
        status: "fail",
        detail: {
          fixture_isrc: fixture,
          validated_candidates: 0,
          error_class: "isrc_no_validated_candidate",
          error_message_safe: `ISRC ${fixture} returned no validated candidate`,
        },
      };
    }
    return { status: "pass", detail: { fixture_isrc: fixture, validated_candidates: validated } };
  } catch (err) {
    return { status: "fail", detail: failureDetail(err) };
  }
}

// ── Registry ────────────────────────────────────────────────────────────

export const CHECKS: readonly CheckDef[] = [
  { name: "env", group: "env", isGroupGate: true, run: checkEnvFn },
  { name: "spotify_token", group: "spotify", isGroupGate: true, run: checkSpotifyToken },
  { name: "spotify_scopes", group: "spotify", isGroupGate: false, run: checkSpotifyScopes },
  { name: "spotify_me", group: "spotify", isGroupGate: false, run: checkSpotifyMe },
  { name: "spotify_search", group: "spotify", isGroupGate: false, run: checkSpotifySearch },
  { name: "apple_dev_token", group: "apple", isGroupGate: true, run: checkAppleDevToken },
  { name: "apple_mut", group: "apple", isGroupGate: false, run: checkAppleMut },
  { name: "apple_storefront", group: "apple", isGroupGate: false, run: checkAppleStorefront },
  { name: "apple_library_read", group: "apple", isGroupGate: false, run: checkAppleLibraryRead },
  { name: "apple_isrc_lookup", group: "apple", isGroupGate: false, run: checkAppleIsrcLookup },
];

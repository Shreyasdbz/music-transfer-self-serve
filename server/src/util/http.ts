// Centralized fetch wrapper per blueprint §12.
//
// Phase 2 surface:
//   - exponential backoff with jitter on 429 / 5xx
//   - honor `Retry-After` (seconds or HTTP-date)
//   - modest concurrency cap (single worker for Phase 2; the matcher in
//     Phase 4+ may bump it, but never high)
//   - request/response logging through util/log.ts (all secrets redacted)
//
// Phase 5+ adds the refresh-on-401 retry hook used by the preflight gate's
// auto-invalidation logic — Phase 2 leaves that as a passthrough.

import { log, redact, redactHeaders, redactUrl } from "./log.js";

export interface HttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | URLSearchParams;
  /** Max retry attempts on 429/5xx. Default: 5. */
  readonly maxRetries?: number;
  /** Hook for refresh-on-401. Returns fresh auth headers to retry with, or
   * undefined to give up. At most one refresh attempt per call. */
  readonly onUnauthorized?: () => Promise<Record<string, string> | undefined>;
  /** When true, a persistent auth/scope failure on this request reports to the
   * gate auto-invalidation sink (set by preflight/gate). Read/search calls
   * that gate on a valid session opt in; OAuth-exchange calls do not. */
  readonly reportAuthFailure?: boolean;
}

// ── Auto-invalidation sink (blueprint §11.1) ─────────────────────────────
// preflight/gate installs this at startup so a persistent 401 (post-refresh)
// or a scope-403 closes the gate. util/http stays ledger-free; the sink is
// the one-way dependency edge.
type AuthFailureTrigger = "auto-401" | "auto-403-scope";
let authFailureSink: ((trigger: AuthFailureTrigger) => void) | undefined;
export function setAuthFailureSink(fn: ((trigger: AuthFailureTrigger) => void) | undefined): void {
  authFailureSink = fn;
}
// Body-classification mirrors preflight/gate.classifyAuthFailure; kept local so
// util/http doesn't import the ledger layer. Both are covered by tests.
function scope403(bodyText: string): boolean {
  const body = bodyText.toLowerCase();
  if (/rate.?limit|too many requests|quota exceeded/.test(body)) return false;
  // Narrow scope/permission match — see preflight/gate.classifyAuthFailure.
  return /scope|insufficient|not authorized|permission/.test(body);
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

const DEFAULT_MAX_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const asNum = Number(value);
  if (Number.isFinite(asNum) && asNum >= 0) return asNum * 1000;
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

function backoffMs(attempt: number): number {
  // 250ms, 500ms, 1s, 2s, 4s base, ± 25% jitter
  const base = 250 * 2 ** attempt;
  const jitter = base * (Math.random() * 0.5 - 0.25);
  return Math.min(30_000, Math.round(base + jitter));
}

export class HttpError extends Error {
  readonly status: number;
  /** Raw upstream response body, redacted through util/log so it's safe to
   * embed in error messages and structured logs. Named without a "safe"
   * suffix — the suffix was misleading because the previous version stored
   * the raw bytes unmodified. */
  readonly body: string;
  /** True when the failure was network-level (DNS, ECONNREFUSED, retry pool
   * exhausted) rather than a real HTTP response. Distinguishes from a real
   * `0` status code so callers can branch on retryability. */
  readonly isNetworkError: boolean;
  constructor(status: number, body: string, url: string, isNetworkError = false) {
    const redactedBody = String(redact(body) ?? "");
    super(`HTTP ${status} from ${redactUrl(url)}: ${redactedBody.slice(0, 200)}`);
    this.name = "HttpError";
    this.status = status;
    this.body = redactedBody;
    this.isNetworkError = isNetworkError;
  }
}

export async function httpRequest(req: HttpRequest): Promise<HttpResponse> {
  const maxRetries = req.maxRetries ?? DEFAULT_MAX_RETRIES;
  let attempt = 0;
  let lastErr: unknown;

  // Phase 2: at most one onUnauthorized retry for the whole call (across
  // attempts). The hook returns refreshed auth headers to retry with, or
  // undefined to give up.
  let triedRefresh = false;
  let headers = req.headers ?? {};

  while (attempt <= maxRetries) {
    let response: Response;
    try {
      const init: RequestInit = { method: req.method, headers };
      if (req.body !== undefined) init.body = req.body;
      response = await fetch(req.url, init);
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) break;
      const wait = backoffMs(attempt);
      log.warn("http.network_error", {
        attempt,
        wait_ms: wait,
        url: redactUrl(req.url),
        message: (err as Error).message,
      });
      await sleep(wait);
      attempt++;
      continue;
    }

    if (response.status === 401 && req.onUnauthorized && !triedRefresh) {
      triedRefresh = true;
      const refreshed = await req.onUnauthorized();
      if (refreshed) {
        headers = { ...headers, ...refreshed };
        continue; // retry without incrementing attempt counter
      }
      // fall through — caller wants the 401 surfaced
    }

    if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
      if (attempt === maxRetries) {
        const text = await response.text();
        throw new HttpError(response.status, text, req.url);
      }
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      const wait = retryAfter ?? backoffMs(attempt);
      log.warn("http.retry", {
        status: response.status,
        attempt,
        wait_ms: wait,
        url: redactUrl(req.url),
      });
      await sleep(wait);
      attempt++;
      continue;
    }

    const text = await response.text();
    log.debug("http.response", {
      status: response.status,
      url: redactUrl(req.url),
      headers: redactHeaders(Object.fromEntries(response.headers)),
    });

    // Refresh-aware auto-invalidation (§11.1). Only fires for opted-in calls:
    //   - 401 that survived the one refresh+retry (triedRefresh true, or no
    //     refresh hook was available) → persistent auth failure
    //   - 403 whose body indicates a scope problem (not rate-limit)
    // Transient 401s recovered by refresh never reach here with status 401
    // (the `continue` retried them); 5xx are handled above and never invalidate.
    if (req.reportAuthFailure && authFailureSink) {
      if (response.status === 401 && (triedRefresh || !req.onUnauthorized)) {
        authFailureSink("auto-401");
      } else if (response.status === 403 && scope403(text)) {
        authFailureSink("auto-403-scope");
      }
    }

    return { status: response.status, headers: response.headers, text };
  }

  throw new HttpError(0, String((lastErr as Error)?.message ?? "unknown"), req.url, true);
}

export async function httpJson<T>(req: HttpRequest): Promise<T> {
  const r = await httpRequest(req);
  if (r.status < 200 || r.status >= 300) {
    throw new HttpError(r.status, r.text, req.url);
  }
  return JSON.parse(r.text) as T;
}

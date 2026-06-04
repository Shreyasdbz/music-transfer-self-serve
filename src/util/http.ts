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

import { log, redactHeaders } from "./log.js";

export interface HttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | URLSearchParams;
  /** Max retry attempts on 429/5xx. Default: 5. */
  readonly maxRetries?: number;
  /** Hook for refresh-on-401. Phase 2 passes through; Phase 5 plugs in. */
  readonly onUnauthorized?: () => Promise<Record<string, string> | undefined>;
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
  readonly bodySafe: string;
  constructor(status: number, bodySafe: string, url: string) {
    super(`HTTP ${status} from ${url}: ${bodySafe.slice(0, 200)}`);
    this.name = "HttpError";
    this.status = status;
    this.bodySafe = bodySafe;
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
        url: req.url,
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
        url: req.url,
      });
      await sleep(wait);
      attempt++;
      continue;
    }

    const text = await response.text();
    log.debug("http.response", {
      status: response.status,
      url: req.url,
      headers: redactHeaders(Object.fromEntries(response.headers)),
    });
    return { status: response.status, headers: response.headers, text };
  }

  throw new HttpError(0, String((lastErr as Error)?.message ?? "unknown"), req.url);
}

export async function httpJson<T>(req: HttpRequest): Promise<T> {
  const r = await httpRequest(req);
  if (r.status < 200 || r.status >= 300) {
    throw new HttpError(r.status, r.text, req.url);
  }
  return JSON.parse(r.text) as T;
}

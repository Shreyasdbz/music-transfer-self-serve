// Typed client for the Hono API (§11.2) + SSE wrappers. CSRF comes from the
// injected <meta> (prod) or GET /api/csrf (dev, where Vite serves the HTML).
// State-changing POSTs send X-CSRF-Token; the dev Vite proxy rewrites Origin.

export interface AuthState {
  connected: boolean;
  expires_at?: number;
  scope?: string;
  captured_at?: number;
  storefront?: string;
}
export interface AuthStatus {
  spotify: AuthState;
  apple: AuthState;
}
export interface Provider {
  id: string;
  displayName: string;
  likedKind: "liked" | "favorites" | "none";
  supportsIsrc: boolean;
  likedReadable: boolean;
}
export interface GateState {
  open: boolean;
  reason: string;
}
export interface CatalogRow {
  platform: string;
  kind: "playlist" | "liked" | "favorites";
  external_id: string;
  name: string | null;
  owner: string | null;
  track_count: number | null;
  url: string | null;
  fetched_at: string | null;
}
export interface CatalogResponse {
  rows: CatalogRow[];
  last_fetched: Record<string, string | null>;
  refreshing: boolean;
}
export interface PreflightCheck {
  seq: number;
  name: string;
  status: "pass" | "fail" | "skip";
  detail: Record<string, unknown>;
  duration_ms: number;
}
export interface PreflightRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  checks?: PreflightCheck[];
}
export interface OperationSummary {
  read: number;
  matched: number;
  skipped: number;
  written: number;
  unmatched: number;
  failed: number;
}
export interface Operation {
  id: string;
  created_at: string;
  finished_at: string | null;
  source: string;
  destination: string;
  source_target: string;
  destination_target: string;
  status: string;
  summary: string | null;
}

export interface TargetInput {
  kind?: "playlist" | "liked" | "favorites";
  id?: string;
  query?: string;
  forceCreate?: boolean;
}
export interface OperationRequest {
  source: string;
  destination: string;
  sourceTarget: TargetInput;
  destinationTarget: TargetInput;
  rematch?: boolean;
}

// ── CSRF + fetch helpers ─────────────────────────────────────────────────
let csrfPromise: Promise<string> | undefined;
async function csrf(): Promise<string> {
  if (!csrfPromise) {
    csrfPromise = (async () => {
      const meta = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content;
      if (meta) return meta;
      try {
        const r = await fetch("/api/csrf");
        if (r.ok) return ((await r.json()) as { csrfToken: string }).csrfToken;
      } catch {
        /* fall through */
      }
      return "";
    })();
  }
  return csrfPromise;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`api_error_${status}`);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new ApiError(r.status, await safeJson(r));
  return (await r.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": await csrf() },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(path, init);
  if (!r.ok) throw new ApiError(r.status, await safeJson(r));
  return (await r.json()) as T;
}

async function safeJson(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return undefined;
  }
}

export const api = {
  authStatus: () => getJson<AuthStatus>("/api/auth/status"),
  providers: () => getJson<{ providers: Provider[] }>("/api/providers").then((r) => r.providers),
  gate: () => getJson<GateState>("/api/gate"),
  spotifyStart: () => postJson<{ authorizeUrl: string }>("/api/auth/spotify/start"),
  appleStart: () => postJson<{ developerToken: string; nonce: string; appName: string }>("/api/auth/apple/start"),
  preflightLatest: () => getJson<PreflightRun | null>("/api/preflight/latest"),
  preflightRun: () => postJson<{ id: string }>("/api/preflight/run"),
  catalog: () => getJson<CatalogResponse>("/api/catalog"),
  catalogRefresh: () => postJson<{ started: true }>("/api/catalog/refresh"),
  catalogCancel: () => postJson<{ cancelled: boolean }>("/api/catalog/refresh/cancel"),
  operations: () => getJson<{ operations: Operation[] }>("/api/operations").then((r) => r.operations),
  operation: (id: string) => getJson<{ operation: Operation; events: unknown[] }>(`/api/operations/${id}`),
  startOperation: (req: OperationRequest) => postJson<{ id: string }>("/api/operations", req),
};

// ── SSE ──────────────────────────────────────────────────────────────────
export interface SseHandle {
  close(): void;
}

/** Subscribe to a named-event SSE stream. `onEvent(type, data)` fires per frame;
 * `onClose` fires when the server closes the stream (terminal event). */
export function openSSE(
  url: string,
  eventNames: string[],
  onEvent: (type: string, data: unknown) => void,
  onClose?: () => void,
): SseHandle {
  const es = new EventSource(url);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    es.close();
    onClose?.();
  };
  for (const name of eventNames) {
    es.addEventListener(name, (e) => {
      let data: unknown = {};
      try {
        data = JSON.parse((e as MessageEvent).data);
      } catch {
        /* keep {} */
      }
      onEvent(name, data);
    });
  }
  // Terminal events that close the stream server-side; the browser would
  // otherwise try to reconnect, so close explicitly.
  for (const terminal of ["done", "interrupted", "complete", "cancelled"]) {
    if (eventNames.includes(terminal)) {
      es.addEventListener(terminal, () => setTimeout(close, 0));
    }
  }
  es.onerror = () => {
    // The server closes cleanly on terminal events; an error after close is
    // expected. Before a terminal event, the browser auto-reconnects.
    if (es.readyState === EventSource.CLOSED) close();
  };
  return { close };
}

export const OPERATION_EVENTS = ["stage", "match", "skip", "write", "unmatched", "error", "done", "interrupted"];
export const PREFLIGHT_EVENTS = ["check", "complete"];
export const CATALOG_EVENTS = ["platform_start", "playlist", "platform_done", "complete", "cancelled", "idle", "error"];

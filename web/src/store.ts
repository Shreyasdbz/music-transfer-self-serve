// App state + actions. Thin signals/stores over the API client; sections read
// these and call the actions. One module so cross-section state (gate gating
// the catalog/operation, a finished run refreshing history) stays coherent.

import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import {
  api,
  openSSE,
  CATALOG_EVENTS,
  OPERATION_EVENTS,
  PREFLIGHT_EVENTS,
  type AuthStatus,
  type CatalogResponse,
  type GateState,
  type Operation,
  type OperationRequest,
  type OperationSummary,
  type PreflightCheck,
  type Provider,
  type TargetInput,
} from "./api/client.js";

const zeroCounts = (): OperationSummary => ({
  read: 0,
  matched: 0,
  skipped: 0,
  written: 0,
  unmatched: 0,
  failed: 0,
});

// ── Top-level state ──────────────────────────────────────────────────────
export const [authStatus, setAuthStatus] = createSignal<AuthStatus | null>(null);
export const [providers, setProviders] = createSignal<Provider[]>([]);
export const [gate, setGate] = createSignal<GateState>({
  open: false,
  reason: "Permissions not checked yet.",
});
export const [catalog, setCatalog] = createSignal<CatalogResponse | null>(null);
export const [history, setHistory] = createSignal<Operation[]>([]);
export const [toast, setToast] = createSignal<string>("");

// Access seam (§15 A3): when the instance requires a token, gate the app behind
// a login screen until authenticated. Defaults to open (local single-owner).
export interface SessionState {
  required: boolean;
  authenticated: boolean;
  checked: boolean;
}
export const [session, setSession] = createStore<SessionState>({
  required: false,
  authenticated: true,
  checked: false,
});

export async function checkSession(): Promise<void> {
  try {
    const s = await api.session();
    setSession({ required: s.required, authenticated: s.authenticated, checked: true });
  } catch {
    setSession({ required: false, authenticated: true, checked: true });
  }
}

export async function submitAccessToken(token: string): Promise<boolean> {
  try {
    await api.login(token);
    setSession("authenticated", true);
    await loadAll();
    return true;
  } catch {
    setToast("Invalid access token.");
    return false;
  }
}

export async function logout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    /* clear locally regardless */
  }
  setSession("authenticated", false);
}

/** Shared 401 handler: an expired/invalid session makes every /api/* call 401.
 * When the instance requires auth, flip the gate back to the Login screen
 * (App.tsx re-renders on `session.authenticated`) and toast once. Returns true
 * if the error was a 401 we handled. */
function handleAuthError(e: unknown): boolean {
  if ((e as { status?: number }).status !== 401 || !session.required) return false;
  if (session.authenticated) {
    setSession("authenticated", false);
    setToast("Session expired — please log in again.");
  }
  return true;
}

/** A catalog "Transfer" click pre-fills the Operation form's source side. */
export interface Prefill {
  provider: string;
  target: TargetInput;
  label: string;
}
export const [prefill, setPrefill] = createSignal<Prefill | undefined>();
export function transferFrom(provider: string, target: TargetInput, label: string): void {
  setPrefill({ provider, target, label });
  document.getElementById("operation")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export interface PreflightState {
  running: boolean;
  checks: Record<number, PreflightCheck>;
  status: string;
}
export const [preflight, setPreflight] = createStore<PreflightState>({
  running: false,
  checks: {},
  status: "",
});

export interface CatalogRefreshState {
  running: boolean;
  message: string;
}
export const [catalogRefresh, setCatalogRefresh] = createStore<CatalogRefreshState>({
  running: false,
  message: "",
});

export interface RunState {
  id: string;
  stage: string;
  counts: OperationSummary;
  log: string[];
  status: string;
  running: boolean;
  logline: string;
}
export const [run, setRun] = createStore<RunState>({
  id: "",
  stage: "",
  counts: zeroCounts(),
  log: [],
  status: "",
  running: false,
  logline: "",
});

const LOG_CAP = 500;

// ── Loaders ──────────────────────────────────────────────────────────────
export async function refreshAuth(): Promise<void> {
  try {
    setAuthStatus(await api.authStatus());
  } catch (e) {
    handleAuthError(e); // else leave prior
  }
}
export async function refreshGate(): Promise<void> {
  try {
    setGate(await api.gate());
  } catch (e) {
    handleAuthError(e);
  }
}
export async function refreshCatalog(): Promise<void> {
  try {
    setCatalog(await api.catalog());
  } catch (e) {
    handleAuthError(e);
  }
}
export async function refreshHistory(): Promise<void> {
  try {
    setHistory(await api.operations());
  } catch (e) {
    handleAuthError(e);
  }
}

export async function loadAll(): Promise<void> {
  await Promise.all([
    refreshAuth(),
    api
      .providers()
      .then(setProviders)
      .catch(() => undefined),
    refreshGate(),
    refreshCatalog(),
    refreshHistory(),
  ]);
  resumeRunningOperation();
}

/** Re-attach to an operation that's still running (e.g. after a page reload).
 * The SSE replays from seq 0, rebuilding the run state. (Resume safety — the
 * old UI did this; the server supports it via Last-Event-ID replay.) */
function resumeRunningOperation(): void {
  if (run.running) return;
  const running = history().find((o) => o.status === "running");
  if (!running) return;
  setRun({
    id: running.id,
    stage: "reconnecting",
    counts: zeroCounts(),
    log: [],
    status: "running",
    running: true,
    logline: "",
  });
  watchOperation(running.id);
}

// ── Auth popups ──────────────────────────────────────────────────────────
function watchPopup(popup: Window | null): void {
  if (!popup) {
    setToast("Popup blocked — allow popups for this site and retry.");
    return;
  }
  const timer = window.setInterval(() => {
    if (popup.closed) {
      window.clearInterval(timer);
      void refreshAuth();
      void refreshGate();
    }
  }, 600);
}

export async function connectSpotify(): Promise<void> {
  try {
    const { authorizeUrl } = await api.spotifyStart();
    watchPopup(window.open(authorizeUrl, "spotify-auth", "width=520,height=720"));
  } catch (e) {
    setToast(`Spotify connect failed: ${(e as Error).message}`);
  }
}
export function connectApple(): void {
  watchPopup(window.open("/musickit.html", "apple-auth", "width=520,height=640"));
}

// ── Permissions preflight ────────────────────────────────────────────────
export async function runPreflight(): Promise<void> {
  if (preflight.running) return;
  setPreflight({ running: true, checks: {}, status: "running" });
  try {
    const { id } = await api.preflightRun();
    openSSE(
      `/api/preflight/${id}/events`,
      PREFLIGHT_EVENTS,
      (type, data) => {
        if (type === "check") {
          const c = data as PreflightCheck;
          setPreflight("checks", c.seq, c);
        } else if (type === "complete") {
          const d = data as { status?: string };
          setPreflight("status", d.status ?? "done");
        }
      },
      () => {
        setPreflight("running", false);
        void refreshGate();
      },
    );
  } catch (e) {
    setPreflight({ running: false, status: "failed" });
    setToast(`Permissions check failed: ${(e as Error).message}`);
  }
}

// ── Catalog refresh ──────────────────────────────────────────────────────
export async function startCatalogRefresh(): Promise<void> {
  if (catalogRefresh.running) return;
  try {
    await api.catalogRefresh();
    setCatalogRefresh({ running: true, message: "Starting…" });
    openSSE(
      "/api/catalog/events",
      CATALOG_EVENTS,
      (type, data) => {
        const d = data as { platform?: string; name?: string };
        if (type === "platform_start") setCatalogRefresh("message", `Refreshing ${d.platform}…`);
        else if (type === "playlist")
          setCatalogRefresh("message", `${d.platform}: ${d.name ?? "playlist"}`);
        else if (type === "idle") setCatalogRefresh("message", "");
      },
      () => {
        setCatalogRefresh({ running: false, message: "" });
        void refreshCatalog();
      },
    );
  } catch (e) {
    const status = (e as { status?: number }).status;
    setCatalogRefresh({ running: false, message: "" });
    if (status === 412) {
      setToast("Run the permissions check first.");
      void refreshGate(); // self-heal a stale-open gate banner
    } else setToast(`Catalog refresh failed: ${(e as Error).message}`);
  }
}
export async function cancelCatalogRefresh(): Promise<void> {
  try {
    await api.catalogCancel();
  } catch {
    /* ignore */
  }
}

// ── Operation run ────────────────────────────────────────────────────────
export type StartResult = { ok: true } | { ok: false; status: number; body: unknown };

export async function startOperation(req: OperationRequest): Promise<StartResult> {
  if (run.running) return { ok: false, status: 409, body: { error: "operation_already_running" } };
  try {
    const { id } = await api.startOperation(req);
    setRun({
      id,
      stage: "starting",
      counts: zeroCounts(),
      log: [],
      status: "running",
      running: true,
      logline: "",
    });
    watchOperation(id);
    return { ok: true };
  } catch (e) {
    const status = (e as { status?: number }).status ?? 0;
    return { ok: false, status, body: (e as { body?: unknown }).body };
  }
}

function watchOperation(id: string): void {
  openSSE(
    `/api/operations/${id}/events`,
    OPERATION_EVENTS,
    (type, data) => {
      const d = data as Record<string, unknown>;
      if (type === "stage") {
        const stage = String(d["stage"] ?? "");
        setRun("stage", stage);
        if (stage === "source_read" && typeof d["count"] === "number")
          setRun("counts", "read", d["count"] as number);
        appendLog(`· ${stage}${d["count"] !== undefined ? ` (${d["count"]})` : ""}`);
      } else if (type === "match") {
        setRun("counts", "matched", (n) => n + 1);
        appendLog(`✓ matched ${d["title"] ?? d["source_id"]} → ${d["tier"]} (${d["confidence"]})`);
      } else if (type === "skip") {
        setRun("counts", "skipped", (n) => n + 1);
      } else if (type === "write") {
        setRun("counts", "written", (n) => n + 1);
        appendLog(`＋ wrote ${d["dest_id"]}`);
      } else if (type === "unmatched") {
        setRun("counts", "unmatched", (n) => n + 1);
        appendLog(`? unmatched ${d["title"] ?? d["source_id"]}`);
      } else if (type === "error") {
        setRun("counts", "failed", (n) => n + 1);
        appendLog(`✗ ${JSON.stringify(d)}`);
      } else if (type === "done") {
        const s = (d["summary"] as OperationSummary) ?? run.counts;
        setRun({ status: String(d["status"] ?? "done"), counts: s, logline: summaryLine(s) });
        appendLog(`done — ${String(d["status"])}`);
      }
    },
    () => {
      // A close with no terminal `done`/`interrupted` (run.status still unset)
      // is a mid-run disconnect, not a clean finish — surface it.
      if (run.running && !run.status) setToast("Connection interrupted — reload to resume.");
      setRun("running", false);
      void refreshHistory();
    },
  );
}

function appendLog(line: string): void {
  setRun("log", (l) => {
    const next = [...l, line];
    return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
  });
}

export function summaryLine(s: OperationSummary): string {
  return `Added ${s.written} · skipped ${s.skipped} · unmatched ${s.unmatched}${s.failed ? ` · failed ${s.failed}` : ""}`;
}

export function clearRun(): void {
  setRun({
    id: "",
    stage: "",
    counts: zeroCounts(),
    log: [],
    status: "",
    running: false,
    logline: "",
  });
}

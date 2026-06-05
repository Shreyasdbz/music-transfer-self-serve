import { createEffect, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Button, StatusPill } from "./components/index.js";
import { Header, Setup } from "./sections/Setup.js";
import { Catalog } from "./sections/Catalog.js";
import { Operation } from "./sections/Operation.js";
import { Status } from "./sections/Status.js";
import { History } from "./sections/History.js";
import {
  checkSession,
  loadAll,
  logout,
  refreshAuth,
  refreshGate,
  session,
  setToast,
  submitAccessToken,
  toast,
} from "./store.js";

function Login(): JSX.Element {
  const [token, setToken] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let inputRef: HTMLInputElement | undefined;
  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const ok = await submitAccessToken(token());
    setBusy(false);
    if (!ok) {
      setError("Invalid access token. Please try again.");
      setToken("");
      inputRef?.focus();
    }
  };
  return (
    <div class="page" style={{ "max-width": "26rem", "padding-top": "18vh" }}>
      <h1 class="t-heading" style={{ margin: 0 }}>
        Music Transfer
      </h1>
      <p class="t-caption" style={{ color: "var(--color-text-muted)" }}>
        This instance is access-protected. Enter the access token to continue.
      </p>
      <form
        onSubmit={(e) => void submit(e)}
        class="stack"
        style={{ "margin-top": "var(--space-lg)" }}
      >
        <input
          ref={inputRef}
          class="text-input t-note"
          type="password"
          placeholder="Access token"
          value={token()}
          onInput={(e) => setToken(e.currentTarget.value)}
          aria-label="Access token"
          aria-invalid={error() ? "true" : undefined}
          aria-describedby={error() ? "token-error" : undefined}
          autofocus
        />
        <Show when={error()}>
          <div id="token-error" role="alert">
            <StatusPill tone="error">{error()}</StatusPill>
          </div>
        </Show>
        <Button variant="tier2" type="submit" disabled={busy() || !token()}>
          {busy() ? "Checking…" : "Enter"}
        </Button>
      </form>
    </div>
  );
}

function Home(): JSX.Element {
  return (
    <div class="page">
      <Show when={session.required}>
        <div
          style={{
            display: "flex",
            "justify-content": "flex-end",
            "margin-bottom": "var(--space-sm)",
          }}
        >
          <Button variant="tier1" onClick={() => void logout()}>
            Log out
          </Button>
        </div>
      </Show>
      <Header />
      <Setup />
      <Catalog />
      <Operation />
      <Status />
      <History />
    </div>
  );
}

export function App(): JSX.Element {
  onMount(() => {
    const onFocus = (): void => {
      void refreshAuth();
      void refreshGate();
    };
    window.addEventListener("focus", onFocus);
    onCleanup(() => window.removeEventListener("focus", onFocus));

    void (async () => {
      await checkSession();
      if (!session.required || session.authenticated) void loadAll();
    })();
  });

  // Auto-dismiss the toast.
  createEffect(() => {
    if (toast()) {
      const id = window.setTimeout(() => setToast(""), 4500);
      onCleanup(() => window.clearTimeout(id));
    }
  });

  return (
    <>
      <Show
        when={session.checked && session.required && !session.authenticated}
        fallback={<Home />}
      >
        <Login />
      </Show>
      <Show when={toast()}>
        <div class="toast t-status" role="status">
          {toast()}
        </div>
      </Show>
    </>
  );
}

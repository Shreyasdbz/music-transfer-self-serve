import { createEffect, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Header, Setup } from "./sections/Setup.js";
import { Catalog } from "./sections/Catalog.js";
import { Operation } from "./sections/Operation.js";
import { Status } from "./sections/Status.js";
import { History } from "./sections/History.js";
import { loadAll, refreshAuth, refreshGate, setToast, toast } from "./store.js";

export function App(): JSX.Element {
  onMount(() => {
    void loadAll();
    // Re-check auth + gate when the window regains focus (after an auth popup).
    const onFocus = (): void => {
      void refreshAuth();
      void refreshGate();
    };
    window.addEventListener("focus", onFocus);
    onCleanup(() => window.removeEventListener("focus", onFocus));
  });

  // Auto-dismiss the toast.
  createEffect(() => {
    if (toast()) {
      const id = window.setTimeout(() => setToast(""), 4500);
      onCleanup(() => window.clearTimeout(id));
    }
  });

  return (
    <div class="page">
      <Header />
      <Setup />
      <Catalog />
      <Operation />
      <Status />
      <History />
      <Show when={toast()}>
        <div class="toast t-status" role="status">
          {toast()}
        </div>
      </Show>
    </div>
  );
}

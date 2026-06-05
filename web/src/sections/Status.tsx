import { For, Show, type JSX } from "solid-js";
import { Button, Card, StatusPill } from "../components/index.js";
import { clearRun, run } from "../store.js";

function tone(status: string): "success" | "warning" | "error" | "general" {
  if (status === "succeeded") return "success";
  if (status === "partial") return "warning";
  if (status === "failed" || status === "interrupted") return "error";
  return "general";
}

export function Status(): JSX.Element {
  return (
    <Show when={run.id || run.log.length > 0}>
      <section class="section" aria-labelledby="status-h">
        <h2 id="status-h" class="section-title t-subheading">
          Status
        </h2>
        <Card>
          <div class="spread">
            <span class="grow t-note">Transfer status</span>
            <Show
              when={run.running}
              fallback={
                <Show when={run.status}>
                  <StatusPill tone={tone(run.status)}>{run.status}</StatusPill>
                </Show>
              }
            >
              <StatusPill tone="general">Running</StatusPill>
            </Show>
            <Button size="sm" disabled={run.running} onClick={clearRun}>
              Clear
            </Button>
          </div>

          <Show when={run.logline}>
            <p class="t-body" style={{ margin: "var(--space-sm) 0 0" }}>
              {run.logline}
            </p>
          </Show>
          <p class="run-counts t-subtle" aria-live="polite">
            read {run.counts.read} · matched {run.counts.matched} · written {run.counts.written} ·
            skipped {run.counts.skipped} · unmatched {run.counts.unmatched}
            {run.counts.failed ? ` · failed ${run.counts.failed}` : ""}
          </p>

          <Show when={run.log.length > 0}>
            <pre class="log t-logline" aria-label="Transfer log">
              <For each={run.log}>{(line) => <div>{line}</div>}</For>
            </pre>
          </Show>
        </Card>
      </section>
    </Show>
  );
}

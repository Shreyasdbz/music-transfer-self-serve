import { For, Show, type JSX } from "solid-js";
import { AppIcon, Card, StatusPill } from "../components/index.js";
import { history } from "../store.js";
import { brandColor } from "./brand.js";

function targetLabel(json: string): string {
  try {
    const t = JSON.parse(json) as { kind?: string; name?: string };
    if (t.kind === "liked") return "Liked";
    if (t.kind === "favorites") return "Favorites";
    if (t.kind === "create") return t.name ?? "new playlist";
    if (t.kind === "playlist") return "playlist";
    return "?";
  } catch {
    return "?";
  }
}

function tone(status: string): "success" | "warning" | "error" | "general" {
  if (status === "succeeded") return "success";
  if (status === "partial") return "warning";
  if (status === "failed" || status === "interrupted") return "error";
  return "general";
}

export function History(): JSX.Element {
  return (
    <Show when={history().length > 0}>
      <section class="section" aria-labelledby="history-h">
        <h2 id="history-h" class="section-title t-subheading">
          History
        </h2>
        <p class="section-sub t-caption">Past operations.</p>
        <div class="stack">
          <For each={history()}>
            {(op) => (
              <Card>
                <div class="history-row">
                  <AppIcon color={brandColor(op.source)} label={op.source} />
                  <span class="history-arrow" aria-hidden="true">
                    →
                  </span>
                  <AppIcon color={brandColor(op.destination)} label={op.destination} />
                  <span class="grow t-note">
                    {targetLabel(op.source_target)} → {targetLabel(op.destination_target)}
                  </span>
                  <StatusPill tone={tone(op.status)}>{op.status}</StatusPill>
                  <Show when={op.finished_at}>
                    <span class="t-subtle" style={{ color: "var(--color-text-muted)" }}>
                      {new Date(op.finished_at!).toLocaleString()}
                    </span>
                  </Show>
                </div>
              </Card>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}

import { For, Show, type JSX } from "solid-js";
import { AppIcon, Button, Collapsible, StatusPill } from "../components/index.js";
import {
  catalog,
  catalogRefresh,
  gate,
  providers,
  startCatalogRefresh,
  transferFrom,
} from "../store.js";
import { brandColor, brandLogo } from "./brand.js";
import type { CatalogRow, TargetInput } from "../api/client.js";

function targetOf(row: CatalogRow): TargetInput {
  if (row.kind === "liked" || row.kind === "favorites") return { kind: row.kind };
  return { kind: "playlist", id: row.external_id };
}

function rowLabel(row: CatalogRow): string {
  return row.name ?? (row.kind === "liked" ? "Liked songs" : row.kind === "favorites" ? "Favorite songs" : row.external_id);
}

export function Catalog(): JSX.Element {
  const rowsFor = (id: string): CatalogRow[] => {
    const rows = (catalog()?.rows ?? []).filter((r) => r.platform === id);
    // Pin liked/favorites first, then playlists.
    return rows.sort((a, b) => {
      const ak = a.kind === "playlist" ? 1 : 0;
      const bk = b.kind === "playlist" ? 1 : 0;
      return ak - bk || (a.name ?? "").localeCompare(b.name ?? "");
    });
  };
  const lastFetched = (id: string): string | null => catalog()?.last_fetched?.[id] ?? null;

  return (
    <section class="section" aria-labelledby="catalog-h">
      <h2 id="catalog-h" class="section-title t-subheading">
        Catalog
      </h2>
      <p class="section-sub t-caption">Your library across services. Refresh to pull the latest playlists.</p>

      <Show when={catalogRefresh.running}>
        <p class="t-subtle" style={{ color: "var(--color-text-muted)", margin: "0 0 var(--space-sm)" }}>
          Refreshing… {catalogRefresh.message}
        </p>
      </Show>

      <div class="stack">
        <For each={providers()}>
          {(p) => (
            <Collapsible
              defaultOpen
              title={
                <span class="spread" style={{ width: "100%" }} classList={{ "provider-coming-soon": p.available === false }}>
                  <AppIcon color={brandColor(p.id)} src={brandLogo(p.id)} label={p.displayName} />
                  <span class="grow">{p.displayName}</span>
                  <Show
                    when={p.available !== false}
                    fallback={<StatusPill tone="general">Coming soon</StatusPill>}
                  >
                    <Show when={lastFetched(p.id)}>
                      <span class="t-subtle" style={{ color: "var(--color-text-muted)" }}>
                        Updated {new Date(lastFetched(p.id)!).toLocaleString()}
                      </span>
                    </Show>
                    <Button
                      size="sm"
                      disabled={!gate().open || catalogRefresh.running}
                      onClick={(e) => {
                        e.stopPropagation();
                        void startCatalogRefresh();
                      }}
                    >
                      Refresh
                    </Button>
                  </Show>
                </span>
              }
            >
              <Show
                when={p.available !== false}
                fallback={
                  <p class="t-subtle" style={{ color: "var(--color-text-muted)" }}>
                    YouTube Music support is coming in a future update.
                  </p>
                }
              >
              <Show
                when={rowsFor(p.id).length > 0}
                fallback={<p class="t-subtle" style={{ color: "var(--color-text-muted)" }}>No catalog yet — Refresh to load.</p>}
              >
                <div>
                  <For each={rowsFor(p.id)}>
                    {(row) => (
                      <div class="playlist-row">
                        <span class="grow t-note">{rowLabel(row)}</span>
                        <Show when={row.track_count != null}>
                          <span class="t-subtle" style={{ color: "var(--color-text-muted)" }}>
                            {row.track_count} tracks
                          </span>
                        </Show>
                        <Button
                          size="sm"
                          onClick={() => transferFrom(p.id, targetOf(row), `${p.displayName}: ${rowLabel(row)}`)}
                        >
                          Transfer
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              </Show>
            </Collapsible>
          )}
        </For>
      </div>
    </section>
  );
}

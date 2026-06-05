import { For, Show, type JSX } from "solid-js";
import { AppIcon, Button, Card, StatusPill, ThemeToggle } from "../components/index.js";
import { authStatus, connectApple, connectSpotify, gate, preflight, providers, runPreflight } from "../store.js";
import { brandColor, brandLogo } from "./brand.js";

export function Header(): JSX.Element {
  return (
    <header class="app-header">
      <div class="header-bar">
        <ThemeToggle />
      </div>
      <h1 class="t-title">MUSIC TRANSFER → Self Serve</h1>
      <p class="intro t-caption">
        Move playlists and liked songs between your music services — safely (additive only) and
        intelligently (the correct recording is matched via ISRC, not a remix or clean edit).
      </p>
    </header>
  );
}

function connected(id: string): boolean {
  const a = authStatus() as Record<string, { connected?: boolean }> | null;
  return !!a?.[id]?.connected;
}

export function Setup(): JSX.Element {
  const sortedChecks = (): typeof preflight.checks[number][] =>
    Object.values(preflight.checks).sort((a, b) => a.seq - b.seq);

  return (
    <section class="section" aria-labelledby="setup-h">
      <h2 id="setup-h" class="section-title t-subheading">
        Setup
      </h2>

      <h3 class="t-headline">Authentication status</h3>
      <p class="section-sub t-caption">Connect each service you want to transfer between.</p>
      <Card>
        <div class="stack">
          <For each={providers()}>
            {(p) => (
              <div class="spread" classList={{ "provider-coming-soon": p.available === false }}>
                <AppIcon color={brandColor(p.id)} src={brandLogo(p.id)} label={p.displayName} />
                <span class="grow t-note">{p.displayName}</span>
                <Show
                  when={p.available !== false}
                  fallback={<StatusPill tone="general">Coming soon</StatusPill>}
                >
                  <span class="t-subtle" style={{ color: "var(--color-text-muted)" }}>
                    {connected(p.id) ? "Connected" : "Not connected"}
                  </span>
                  <Show when={p.id === "spotify"}>
                    <Button size="sm" onClick={() => void connectSpotify()}>
                      {connected("spotify") ? "Reconnect" : "Connect"}
                    </Button>
                  </Show>
                  <Show when={p.id === "apple"}>
                    <Button size="sm" onClick={() => connectApple()}>
                      {connected("apple") ? "Reconnect" : "Connect"}
                    </Button>
                  </Show>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Card>

      <h3 class="t-headline" style={{ "margin-top": "var(--space-lg)" }}>
        Permissions status
      </h3>
      <p class="section-sub t-caption">
        Exercises every credential, scope, and read capability before catalog or transfers are allowed.
      </p>
      <Card>
        <div class="spread">
          <span class="grow t-note">Permissions check</span>
          <Button size="sm" disabled={preflight.running} onClick={() => void runPreflight()}>
            {preflight.running ? "Checking…" : "Check"}
          </Button>
        </div>
        <div class="banner" data-open={gate().open} style={{ "margin-top": "var(--space-md)" }}>
          <span class="t-subtle">{gate().reason}</span>
        </div>
        <Show when={sortedChecks().length > 0}>
          <ul class="check-list t-subtle">
            <For each={sortedChecks()}>
              {(c) => (
                <li data-status={c.status}>
                  <span class="check-mark" aria-hidden="true">
                    {c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "–"}
                  </span>
                  <span class="check-name">{c.name}</span>
                  <span class="t-subtle" style={{ color: "var(--color-text-muted)" }}>
                    {c.status}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Card>
    </section>
  );
}

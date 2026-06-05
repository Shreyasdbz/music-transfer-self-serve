// V4 design-system showcase: renders every primitive + the type scale in the
// current theme. (V5 replaces this with the real home sections.) Brand colors on
// the provider icons are data, not theme tokens.

import { createSignal, type JSX } from "solid-js";
import {
  AppIcon,
  Button,
  Card,
  Collapsible,
  Dropdown,
  PermissionRow,
  StatusDot,
  StatusPill,
  ThemeToggle,
} from "./components/index.js";

const TYPE_ROLES = [
  "title",
  "heading",
  "subheading",
  "headline",
  "body",
  "caption",
  "note",
  "subtle",
  "button",
  "button2",
  "status",
  "logline",
];

function Section(props: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <section style={{ "margin-bottom": "var(--space-xl)" }}>
      <h2 class="t-subheading" style={{ margin: "0 0 var(--space-md)" }}>
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

export function App(): JSX.Element {
  const [picked, setPicked] = createSignal("gym");
  return (
    <main style={{ "max-width": "60rem", margin: "0 auto", padding: "var(--space-xl)" }}>
      <header style={{ display: "flex", "align-items": "center", gap: "var(--space-md)", "margin-bottom": "var(--space-xl)" }}>
        <h1 class="t-heading" style={{ margin: 0, "margin-right": "auto" }}>
          Design System
        </h1>
        <ThemeToggle />
      </header>

      <Section title="Typography">
        <Card>
          <div style={{ display: "flex", "flex-direction": "column", gap: "var(--space-sm)" }}>
            {TYPE_ROLES.map((role) => (
              <div class={`t-${role}`}>
                {role} — The quick brown fox 0123
              </div>
            ))}
          </div>
        </Card>
      </Section>

      <Section title="Buttons">
        <div style={{ display: "flex", gap: "var(--space-md)", "flex-wrap": "wrap", "align-items": "center" }}>
          <Button variant="tier1">Button text</Button>
          <Button variant="tier1" disabled>
            Button text
          </Button>
          <Button variant="tier2">Button2 Text</Button>
          <Button variant="tier2" disabled>
            Button2 Text
          </Button>
          <Button variant="tier1" size="sm">
            Check
          </Button>
        </div>
      </Section>

      <Section title="Status">
        <div style={{ display: "flex", gap: "var(--space-sm)", "flex-wrap": "wrap", "align-items": "center" }}>
          <StatusPill tone="success">Success</StatusPill>
          <StatusPill tone="warning">Warning</StatusPill>
          <StatusPill tone="error">Error</StatusPill>
          <StatusPill tone="general">General</StatusPill>
          <span style={{ display: "inline-flex", "align-items": "center", gap: "var(--space-xs)" }}>
            <StatusDot state="on" label="connected" /> <span class="t-subtle">on</span>
          </span>
          <span style={{ display: "inline-flex", "align-items": "center", gap: "var(--space-xs)" }}>
            <StatusDot state="off" label="disconnected" /> <span class="t-subtle">off</span>
          </span>
        </div>
      </Section>

      <Section title="Permission rows">
        <div style={{ display: "flex", "flex-direction": "column", gap: "var(--space-md)", "align-items": "flex-start" }}>
          <PermissionRow icon={<AppIcon color="#1DB954" label="Spotify" />} label="Spotify" state="on" />
          <PermissionRow icon={<AppIcon color="#FA243C" label="Apple Music" />} label="Apple Music" state="off" />
          <PermissionRow icon={<AppIcon color="#FF0000" label="YouTube Music" />} label="YouTube Music" state="error" />
        </div>
      </Section>

      <Section title="Dropdown">
        <Dropdown
          aria-label="Source playlist"
          value={picked()}
          onChange={setPicked}
          options={[
            { value: "liked", label: "★ Liked songs" },
            { value: "gym", label: "Gym workout" },
            { value: "road", label: "Road trip" },
          ]}
        />
      </Section>

      <Section title="Collapsible">
        <Collapsible title="Spotify" defaultOpen>
          <p class="t-body" style={{ margin: 0 }}>
            Playlists would list here, each with a Transfer button.
          </p>
        </Collapsible>
      </Section>
    </main>
  );
}

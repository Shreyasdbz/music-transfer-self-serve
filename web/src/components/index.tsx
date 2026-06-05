// Design-system primitives (Figma_Components.png). Every component renders from
// the design tokens via CSS classes — no literal colors in this file. a11y:
// native <button>/<select>, aria-expanded/aria-pressed, role=img + labels on
// non-text indicators; focus-visible + reduced-motion handled in tokens.css.

import { createSignal, For, Show, splitProps, type JSX } from "solid-js";
import { useTheme, type ThemePref } from "../theme/ThemeProvider.js";

// ── Card ──────────────────────────────────────────────────────────────
export function Card(props: { children: JSX.Element; class?: string }): JSX.Element {
  return <div class={`card ${props.class ?? ""}`}>{props.children}</div>;
}

// ── Button (tier-1 outline / tier-2 filled) ───────────────────────────
type ButtonProps = {
  variant?: "tier1" | "tier2";
  size?: "sm";
  children: JSX.Element;
} & JSX.ButtonHTMLAttributes<HTMLButtonElement>;

export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ["variant", "size", "children", "class", "type"]);
  const variant = local.variant ?? "tier1";
  const typeClass = variant === "tier2" ? "t-button2" : "t-button";
  return (
    <button
      type={local.type ?? "button"}
      {...rest}
      class={`btn btn-${variant} ${typeClass} ${local.size === "sm" ? "btn-sm" : ""} ${local.class ?? ""}`}
    >
      {local.children}
    </button>
  );
}

// ── Status pill ───────────────────────────────────────────────────────
export function StatusPill(props: {
  tone: "success" | "warning" | "error" | "general";
  children: JSX.Element;
}): JSX.Element {
  return (
    <span class={`pill pill-${props.tone} t-status`}>
      <Show when={props.tone === "general"}>
        <span class="pill-glyph" aria-hidden="true">
          ○
        </span>
      </Show>
      {props.children}
    </span>
  );
}

// ── Status dot (connection indicator) ─────────────────────────────────
// `decorative` drops the ARIA role/label — use it when a visible text label
// already conveys the state (so SR users don't hear it twice).
export function StatusDot(props: {
  state: "on" | "off" | "error";
  label?: string;
  decorative?: boolean;
}): JSX.Element {
  if (props.decorative)
    return <span class="status-dot" data-state={props.state} aria-hidden="true" />;
  return (
    <span
      class="status-dot"
      data-state={props.state}
      role="img"
      aria-label={props.label ?? props.state}
    />
  );
}

const STATE_TEXT: Record<"on" | "off" | "error", string> = {
  on: "Connected",
  off: "Not connected",
  error: "Error",
};

// ── App / provider icon (brand color is data, not a theme token) ──────
// With `src`, renders the brand logo image (the PNGs are already full circular
// marks, so no color chip behind them). Without, falls back to a color chip.
export function AppIcon(props: {
  color: string;
  label: string;
  src?: string | undefined;
  children?: JSX.Element;
}): JSX.Element {
  // Decorative: every call site renders the provider name as adjacent text, so
  // the logo carries no extra info for SR users (mirrors StatusDot `decorative`).
  if (props.src) {
    return <img class="app-icon app-icon-img" src={props.src} alt="" aria-hidden="true" />;
  }
  return (
    <span class="app-icon" style={{ background: props.color }} aria-hidden="true">
      {props.children}
    </span>
  );
}

// ── Permission / connection row ───────────────────────────────────────
export function PermissionRow(props: {
  icon: JSX.Element;
  label: string;
  state: "on" | "off" | "error";
  onCheck?: () => void;
  checkLabel?: string;
}): JSX.Element {
  return (
    <div class="row">
      {props.icon}
      <span class="row-label t-note">{props.label}</span>
      {/* State shown by BOTH a visible word and color (not color alone — 1.4.1). */}
      <span class="row-state">
        <StatusDot state={props.state} decorative />
        <span class="row-state-text t-subtle">{STATE_TEXT[props.state]}</span>
      </span>
      <Button size="sm" onClick={() => props.onCheck?.()}>
        {props.checkLabel ?? "Check"}
      </Button>
    </div>
  );
}

// ── Dropdown (native select) ──────────────────────────────────────────
export function Dropdown(props: {
  value?: string;
  options: { value: string; label: string }[];
  onChange?: (v: string) => void;
  "aria-label": string;
}): JSX.Element {
  return (
    <select
      class="dropdown t-note"
      aria-label={props["aria-label"]}
      value={props.value ?? ""}
      onChange={(e) => props.onChange?.(e.currentTarget.value)}
    >
      <For each={props.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
    </select>
  );
}

// ── Collapsible ───────────────────────────────────────────────────────
export function Collapsible(props: {
  title: JSX.Element;
  children: JSX.Element;
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false);
  return (
    <div class="collapsible" data-open={open()}>
      <button class="collapsible-header" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="collapsible-title t-note">{props.title}</span>
        <span class="collapsible-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      <Show when={open()}>
        <div class="collapsible-body">{props.children}</div>
      </Show>
    </div>
  );
}

// ── Theme toggle (segmented light/dark/auto) ──────────────────────────
export function ThemeToggle(): JSX.Element {
  const { pref, setPref } = useTheme();
  const opts: ThemePref[] = ["light", "dark", "auto"];
  return (
    <div class="theme-toggle t-status" role="group" aria-label="Color theme">
      <For each={opts}>
        {(o) => (
          <button aria-pressed={pref() === o} onClick={() => setPref(o)}>
            {o}
          </button>
        )}
      </For>
    </div>
  );
}

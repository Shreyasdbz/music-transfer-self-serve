// Design tokens — the single source of truth for the UI, from the Figma mockups
// (mockups/Figma_Colors.png, Figma_Typography.png, Figma_Components.png).
//
// The LIGHT palette is the Figma palette verbatim. The DARK palette is DERIVED
// here and verified to meet WCAG AA contrast for every text/surface and status
// pair (see contrast.test.ts). `tokens.css` is GENERATED from these values by
// build.ts — never hand-edit tokens.css. Components consume ONLY the emitted
// CSS custom properties / type classes (no ad-hoc hex).

// ── Color roles ──────────────────────────────────────────────────────────
export interface ColorTokens {
  bg: string; // page background (Figma bg-primary)
  surface: string; // cards / rows (Figma bg-secondary)
  text: string; // primary text (Figma fg-primary)
  textSecondary: string; // secondary text (Figma fg-secondary)
  textMuted: string; // captions / metadata
  border: string; // hairlines / card stroke (Figma card-stroke)
  // tier-1 button (outline/light)
  btn1Bg: string;
  btn1BgHover: string;
  btn1Text: string;
  btn1Border: string;
  // tier-2 button (filled/primary)
  btn2Bg: string;
  btn2BgHover: string;
  btn2Text: string;
  btn2Disabled: string;
  // status
  statusSuccess: string;
  statusWarning: string;
  statusError: string;
  statusText: string; // text/glyph color ON the solid status pills (AA-safe)
  focusRing: string;
}

/** Figma light palette (verbatim) mapped to semantic roles. */
export const lightColors: ColorTokens = {
  bg: "#F8F8F8", // bg-primary
  surface: "#FFFFFF", // bg-secondary
  text: "#000000", // fg-primary
  textSecondary: "#222426", // fg-secondary
  textMuted: "#6A6A6A", // gray-0 (AA on both bg and surface)
  border: "#E8E8E8", // card-stroke
  btn1Bg: "#F5F5F5", // fg-btn-1-rest
  btn1BgHover: "#FFFFFF", // fg-btn-1-hover
  btn1Text: "#000000",
  btn1Border: "#E8E8E8",
  btn2Bg: "#000000", // fg-btn-2-rest
  btn2BgHover: "#1A1A1A", // fg-btn-2-hover
  btn2Text: "#FFFFFF",
  btn2Disabled: "#D1D1D1", // gray-3
  statusSuccess: "#34C759",
  statusWarning: "#FFCC00",
  statusError: "#FF383C",
  // The Figma mockup shows white text on the bright pills, but white fails WCAG
  // AA on all three (2.2:1 / 1.5:1 / 3.6:1). Dark text passes (8:1 / 14:1 /
  // 5.9:1) and keeps the Figma fill colors — a deliberate a11y refinement.
  statusText: "#1A1A1A",
  focusRing: "#0A84FF",
};

/** Derived dark palette. Verified AA in contrast.test.ts. */
export const darkColors: ColorTokens = {
  bg: "#141414",
  surface: "#1E1E1E",
  text: "#F5F5F5",
  textSecondary: "#C8C8C8",
  textMuted: "#9A9A9A",
  border: "#333333",
  btn1Bg: "#262626",
  btn1BgHover: "#333333",
  btn1Text: "#F5F5F5",
  btn1Border: "#3A3A3A",
  btn2Bg: "#F5F5F5", // tier-2 inverts in dark (light button, dark label)
  btn2BgHover: "#FFFFFF",
  btn2Text: "#141414",
  btn2Disabled: "#3A3A3A",
  // Same solid Figma fills; the pill is a self-contained color island, so dark
  // text remains AA in dark mode too.
  statusSuccess: "#34C759",
  statusWarning: "#FFCC00",
  statusError: "#FF383C",
  statusText: "#1A1A1A",
  focusRing: "#4DA3FF",
};

export type ThemeName = "light" | "dark";
export const palettes: Record<ThemeName, ColorTokens> = { light: lightColors, dark: darkColors };

// ── Typography (Figma_Typography.png) ────────────────────────────────────
export interface TypeToken {
  family: "inter" | "mono";
  size: number; // px (pt≈px on screen)
  weight: number;
  tracking: number; // em (Figma "% tracking" / 100)
  lineHeight: number;
}

export const typography: Record<string, TypeToken> = {
  title: { family: "inter", size: 56, weight: 800, tracking: -0.04, lineHeight: 1.05 },
  heading: { family: "inter", size: 32, weight: 700, tracking: -0.04, lineHeight: 1.1 },
  subheading: { family: "inter", size: 24, weight: 500, tracking: -0.04, lineHeight: 1.2 },
  headline: { family: "inter", size: 24, weight: 500, tracking: -0.04, lineHeight: 1.2 },
  body: { family: "inter", size: 20, weight: 400, tracking: -0.04, lineHeight: 1.4 },
  caption: { family: "inter", size: 18, weight: 300, tracking: 0, lineHeight: 1.4 },
  note: { family: "inter", size: 16, weight: 500, tracking: -0.04, lineHeight: 1.4 },
  subtle: { family: "inter", size: 14, weight: 400, tracking: -0.04, lineHeight: 1.4 },
  button: { family: "mono", size: 16, weight: 500, tracking: -0.04, lineHeight: 1 },
  button2: { family: "mono", size: 18, weight: 500, tracking: -0.04, lineHeight: 1 },
  status: { family: "mono", size: 14, weight: 500, tracking: -0.04, lineHeight: 1 },
  logline: { family: "mono", size: 10, weight: 400, tracking: -0.02, lineHeight: 1.5 },
};

// ── Space / radius / shadow ──────────────────────────────────────────────
export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, cardX: 40, cardY: 30 };
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };
export const shadowLight = "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.05)";
export const shadowDark = "0 1px 3px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.4)";

export const fontStacks = {
  inter: `"Inter", system-ui, -apple-system, sans-serif`,
  mono: `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace`,
};

// ── WCAG contrast helpers (used by tokens.css generation + the AA test) ───
function channel(hex2: string): number {
  const c = parseInt(hex2, 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = channel(h.slice(0, 2));
  const g = channel(h.slice(2, 4));
  const b = channel(h.slice(4, 6));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG 2.x contrast ratio (1..21) between two hex colors. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ── CSS generation (single source → tokens.css) ──────────────────────────
function colorVars(c: ColorTokens): string {
  return Object.entries(c)
    .map(([k, v]) => `  --color-${kebab(k)}: ${v};`)
    .join("\n");
}
function kebab(s: string): string {
  // Split on UPPERCASE only — NOT digits. `/[A-Z0-9]+/` groups a digit with the
  // following capital (e.g. "btn1Bg" → "1B" → "btn-1bg"), which mis-named every
  // button var and left the Button system unstyled. "btn1Bg" → "btn1-bg".
  return s.replace(/[A-Z]+/g, (m) => "-" + m.toLowerCase());
}
function typeClasses(): string {
  return Object.entries(typography)
    .map(([name, t]) => {
      const fam = t.family === "inter" ? "var(--font-inter)" : "var(--font-mono)";
      // rem (base 16px) so the type scale respects the user's OS/browser
      // font-size preference (a11y), not just page zoom.
      return `.t-${name} {\n  font-family: ${fam};\n  font-size: ${t.size / 16}rem;\n  font-weight: ${t.weight};\n  letter-spacing: ${t.tracking}em;\n  line-height: ${t.lineHeight};\n}`;
    })
    .join("\n");
}

/** Generate the full tokens.css (consumed by the web app). */
export function generateCss(): string {
  return `/* GENERATED by packages/design-tokens/build.ts — do not edit by hand. */
:root {
  --font-inter: ${fontStacks.inter};
  --font-mono: ${fontStacks.mono};
  --space-xs: ${space.xs}px;
  --space-sm: ${space.sm}px;
  --space-md: ${space.md}px;
  --space-lg: ${space.lg}px;
  --space-xl: ${space.xl}px;
  --space-card-x: ${space.cardX}px;
  --space-card-y: ${space.cardY}px;
  --radius-sm: ${radius.sm}px;
  --radius-md: ${radius.md}px;
  --radius-lg: ${radius.lg}px;
  --radius-pill: ${radius.pill}px;
  --shadow-1: ${shadowLight};
  color-scheme: light;
${colorVars(lightColors)}
}

[data-theme="dark"] {
  color-scheme: dark;
  --shadow-1: ${shadowDark};
${colorVars(darkColors)}
}

/* Auto theme: follow the system when no explicit [data-theme] is set. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    color-scheme: dark;
    --shadow-1: ${shadowDark};
${colorVars(darkColors)}
  }
}

*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-inter);
  -webkit-font-smoothing: antialiased;
}

:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
  border-radius: 2px;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0.001ms !important;
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
  }
}

/* Typography utility classes (one per Figma role). */
${typeClasses()}
`;
}

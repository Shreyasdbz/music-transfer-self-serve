// WCAG AA contrast verification for the design tokens (V4 AC). Asserts ≥4.5:1
// for text/surface pairs in BOTH themes and ≥3:1 for the focus ring (1.4.11).
// A regression to a non-compliant palette fails CI.

import {
  contrastRatio,
  lightColors,
  darkColors,
  type ColorTokens,
  type ThemeName,
} from "./tokens.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    process.stderr.write(`FAIL  ${msg}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS  ${msg}\n`);
}

const AA = 4.5; // normal text
const UI = 3.0; // focus ring / non-text (1.4.11)

function checkTheme(name: ThemeName, c: ColorTokens): void {
  const text: Array<[string, string, string]> = [
    ["text on bg", c.text, c.bg],
    ["text on surface", c.text, c.surface],
    ["textSecondary on surface", c.textSecondary, c.surface],
    ["textSecondary on bg", c.textSecondary, c.bg],
    ["textMuted on bg", c.textMuted, c.bg],
    ["textMuted on surface", c.textMuted, c.surface],
    ["btn1Text on btn1Bg", c.btn1Text, c.btn1Bg],
    ["btn1Text on btn1BgHover", c.btn1Text, c.btn1BgHover],
    ["btn2Text on btn2Bg", c.btn2Text, c.btn2Bg],
    ["btn2Text on btn2BgHover", c.btn2Text, c.btn2BgHover],
    ["statusText on success", c.statusText, c.statusSuccess],
    ["statusText on warning", c.statusText, c.statusWarning],
    ["statusText on error", c.statusText, c.statusError],
  ];
  for (const [label, fg, bg] of text) {
    const r = contrastRatio(fg, bg);
    assert(r >= AA, `${name}: ${label} = ${r.toFixed(2)}:1 (≥${AA})`);
  }
  // Focus ring against both backgrounds (UI component contrast).
  assert(
    contrastRatio(c.focusRing, c.bg) >= UI,
    `${name}: focusRing on bg = ${contrastRatio(c.focusRing, c.bg).toFixed(2)}:1 (≥${UI})`,
  );
  assert(
    contrastRatio(c.focusRing, c.surface) >= UI,
    `${name}: focusRing on surface = ${contrastRatio(c.focusRing, c.surface).toFixed(2)}:1 (≥${UI})`,
  );
}

checkTheme("light", lightColors);
checkTheme("dark", darkColors);

// Sanity: the helper matches a known pair (black on white = 21:1).
assert(Math.round(contrastRatio("#000000", "#FFFFFF")) === 21, "contrastRatio: black/white = 21:1");

process.exit(process.exitCode ?? 0);

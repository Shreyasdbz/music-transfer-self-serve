// Guards the GENERATED tokens.css (the artifact the web app imports) — the
// contrast test only checks the TS token objects, which is exactly how the
// kebab() var-name bug shipped. Two checks:
//   1. the committed tokens.css matches the generator output (no drift);
//   2. every --color-* var referenced by components.css is actually DEFINED
//      (catches a name mismatch that would leave components unstyled).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCss } from "./tokens.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    process.stderr.write(`FAIL  ${msg}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS  ${msg}\n`);
}

const here = dirname(fileURLToPath(import.meta.url));
const css = generateCss();

// 1) No drift: the committed CSS equals the current generator output.
const committed = readFileSync(resolve(here, "tokens.css"), "utf8");
assert(
  committed === css,
  "tokens.css is up to date with the generator (run `npm run build -w @mtss/design-tokens`)",
);

// 2) Var superset: every --color-* used by the components is defined.
const defined = new Set([...css.matchAll(/(--color-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const componentsCssPath = resolve(here, "../../web/src/styles/components.css");
const componentsCss = readFileSync(componentsCssPath, "utf8");
const referenced = [...componentsCss.matchAll(/var\((--color-[a-z0-9-]+)\)/g)].map((m) => m[1]!);
const referencedSet = new Set(referenced);
const missing = [...referencedSet].filter((v) => !defined.has(v));

assert(
  referencedSet.size > 0,
  `found --color-* references in components.css (got ${referencedSet.size})`,
);
assert(
  missing.length === 0,
  `every --color-* used in components.css is defined by the tokens (missing: ${missing.join(", ") || "none"})`,
);

process.exit(process.exitCode ?? 0);

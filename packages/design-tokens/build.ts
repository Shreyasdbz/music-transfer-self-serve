// Generates tokens.css from tokens.ts (the single source of truth).
// Run: `npm run build -w @mtss/design-tokens`.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCss } from "./tokens.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "tokens.css");
writeFileSync(out, generateCss());
process.stdout.write(`design-tokens: wrote ${out}\n`);

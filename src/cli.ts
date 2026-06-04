// Minimal CLI. `doctor` runs the same 10-check preflight as the UI's
// "Check permissions" button, via the shared runner (surface='cli'), writes
// the same ledger rows, and prints a pretty grouped checklist (blueprint
// §11.3). A `doctor` pass counts for the UI's gate, and vice versa.

import { openLedger, closeLedger } from "./ledger/db.js";
import { runPreflight } from "./preflight/runner.js";
import { installAuthFailureSink } from "./preflight/gate.js";
import { getPreflightRun, computeGateState } from "./ledger/preflightStore.js";

const GROUPS: { label: string; names: string[] }[] = [
  { label: "Environment", names: ["env"] },
  { label: "Spotify", names: ["spotify_token", "spotify_scopes", "spotify_me", "spotify_search"] },
  { label: "Apple", names: ["apple_dev_token", "apple_mut", "apple_storefront", "apple_library_read", "apple_isrc_lookup"] },
];

const MARK: Record<string, string> = { pass: "✅", fail: "❌", skip: "⏭️ " };

async function doctor(): Promise<number> {
  openLedger();
  // Same wiring as the server: a persistent 401 / scope-403 during the run
  // closes the gate, so a doctor that detects bad creds invalidates the gate
  // for the UI too (and vice versa) — symmetric auto-invalidation.
  installAuthFailureSink();
  process.stdout.write("Running permissions preflight (doctor)…\n");

  const handle = runPreflight({ trigger: "cli", surface: "cli" });
  // The two platform groups run in parallel, so streaming interleaves. Wait
  // for completion, then render grouped + in seq order from the persisted rows.
  const status = await handle.done;

  const run = getPreflightRun(handle.id);
  const byName = new Map((run?.checks ?? []).map((c) => [c.name, c]));
  for (const group of GROUPS) {
    process.stdout.write(`\n  ${group.label}\n`);
    for (const name of group.names) {
      const c = byName.get(name);
      if (!c) continue;
      const detail = c.detail ? redactedDetailLine(JSON.parse(c.detail)) : "";
      process.stdout.write(`    ${MARK[c.status] ?? "?"} ${name}${detail ? "  — " + detail : ""}\n`);
    }
  }

  const gate = computeGateState();
  process.stdout.write(`\nResult: ${status.toUpperCase()}\n`);
  process.stdout.write(`Gate:   ${gate.open ? "OPEN" : "CLOSED"} — ${gate.reason}\n`);

  closeLedger();
  // Exit 0 only when the run passed; non-zero is useful for scripting.
  return status === "passed" ? 0 : 1;
}

/** A compact, already-redaction-safe one-line detail for the CLI. The detail
 * objects come from preflight/checks (which redacts error_message_safe), so we
 * just stringify the salient fields. */
function redactedDetailLine(detail: Record<string, unknown>): string {
  if ("error_message_safe" in detail) return String(detail["error_message_safe"]);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (k === "error_class") continue;
    parts.push(`${k}=${Array.isArray(v) ? `[${v.join(",")}]` : String(v)}`);
  }
  return parts.join(" ");
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "doctor") {
    const code = await doctor();
    process.exit(code);
  }
  process.stderr.write("usage: tsx src/cli.ts doctor\n");
  process.exit(2);
}

void main();

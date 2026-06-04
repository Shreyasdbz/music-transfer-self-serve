// Placeholder CLI — Phase 5 will implement `doctor` as the headless surface
// over preflight/runner.ts. Until then, exit with a clear message so anyone
// following the README sees the right pointer instead of a tsx
// "Cannot find module" error.

const sub = process.argv[2];

if (sub === "doctor") {
  process.stderr.write(
    "doctor: not implemented yet (Phase 5 deliverable per blueprint.md §13).\n",
  );
  process.exit(2);
}

process.stderr.write(`usage: tsx src/cli.ts doctor\n`);
process.exit(2);

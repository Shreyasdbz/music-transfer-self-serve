// V6 env-driven config (blueprint §15 A1). Sets network env BEFORE importing
// config (ESM hoist + dotenv-no-override means process.env wins). A module is
// cached per process, so this file covers ONE scenario (network/HTTPS) for the
// derivations, plus a child process for the parsePort failure path.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env["PUBLIC_ORIGIN"] = "https://music.example.com/"; // trailing slash → stripped
process.env["PORT"] = "9999";
delete process.env["ALLOWED_ORIGINS"]; // exercise the derive-from-PUBLIC_ORIGIN default
delete process.env["ALLOWED_HOSTS"];
delete process.env["BIND_HOST"]; // default 127.0.0.1

function assert(c: unknown, m: string): void {
  if (!c) {
    process.stderr.write(`FAIL  ${m}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS  ${m}\n`);
}

const cfg = await import("./config.js");

assert(cfg.HTTP_HOST === "127.0.0.1", `HTTP_HOST defaults to 127.0.0.1 (got ${cfg.HTTP_HOST})`);
assert(cfg.HTTP_PORT === 9999, `PORT parsed (got ${cfg.HTTP_PORT})`);
assert(cfg.PUBLIC_ORIGIN === "https://music.example.com", `PUBLIC_ORIGIN trailing slash stripped (got ${cfg.PUBLIC_ORIGIN})`);
assert(
  cfg.SPOTIFY_REDIRECT_URI_EXPECTED === "https://music.example.com/auth/spotify/callback",
  `redirect URI derived from PUBLIC_ORIGIN (got ${cfg.SPOTIFY_REDIRECT_URI_EXPECTED})`,
);
assert(
  cfg.ALLOWED_ORIGINS.length === 1 && cfg.ALLOWED_ORIGINS[0] === "https://music.example.com",
  `ALLOWED_ORIGINS defaults to [PUBLIC_ORIGIN] (got ${JSON.stringify(cfg.ALLOWED_ORIGINS)})`,
);
assert(
  cfg.ALLOWED_HOSTS.length === 1 && cfg.ALLOWED_HOSTS[0] === "music.example.com",
  `ALLOWED_HOSTS defaults to host of PUBLIC_ORIGIN (got ${JSON.stringify(cfg.ALLOWED_HOSTS)})`,
);

// parsePort: a malformed PORT must fail fast at config load (child process, so
// it doesn't crash this one). Import the module with PORT=abc → non-zero exit.
const configPath = fileURLToPath(new URL("./config.ts", import.meta.url));
let threw = false;
try {
  execFileSync("npx", ["tsx", "-e", `import(${JSON.stringify(configPath)})`], {
    env: { ...process.env, PORT: "abc", PUBLIC_ORIGIN: "http://127.0.0.1:8888" },
    stdio: "pipe",
  });
} catch {
  threw = true;
}
assert(threw, "malformed PORT throws at config load (fail-fast)");

process.stdout.write("config.test.ts done\n");

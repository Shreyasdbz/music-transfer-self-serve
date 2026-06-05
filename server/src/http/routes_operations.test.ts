// Unit tests for the operations target-classification helpers (the pure parts
// of §9 resolution). The full async resolveTarget needs live clients + the
// ledger; it's covered by the live AC. These cover the URL/bare-id precedence
// fixes from the Phase 6 validation sweep.

import { parseUrl, looksLikeBareId } from "./routes_operations.js";

function assert(c: unknown, m: string): void {
  if (!c) { process.stderr.write(`FAIL  ${m}\n`); process.exitCode = 1; }
  else process.stdout.write(`PASS  ${m}\n`);
}

// ── parseUrl: only real URLs resolve to an id directly ───────────────────
assert(parseUrl("spotify", "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M") === "37i9dQZF1DXcBWIGoYBM5M", "parseUrl: spotify https URL");
assert(parseUrl("spotify", "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M") === "37i9dQZF1DXcBWIGoYBM5M", "parseUrl: spotify URI");
assert(parseUrl("spotify", "My Playlist") === undefined, "parseUrl: a name is not a URL");
assert(parseUrl("spotify", "37i9dQZF1DXcBWIGoYBM5M") === undefined, "parseUrl: a bare id is NOT a URL (must go through name resolution first)");
assert(parseUrl("apple", "https://music.apple.com/us/playlist/chill/pl.abc123") === "pl.abc123", "parseUrl: apple URL");
assert(parseUrl("apple", "p.zp6K4poh") === undefined, "parseUrl: bare apple id is not a URL");

// ── looksLikeBareId ──────────────────────────────────────────────────────
assert(looksLikeBareId("spotify", "37i9dQZF1DXcBWIGoYBM5M"), "bareId: 22-char spotify id");
assert(!looksLikeBareId("spotify", "short"), "bareId: short string is not an id");
assert(!looksLikeBareId("spotify", "My 22 Character Playlist!"), "bareId: a name with spaces/punct is not an id");
assert(looksLikeBareId("apple", "p.zp6K4pohPXYPY4"), "bareId: apple library id (p.)");
assert(looksLikeBareId("apple", "pl.abc123def"), "bareId: apple catalog id (pl.)");
assert(!looksLikeBareId("apple", "My Playlist"), "bareId: apple name is not an id");

process.exit(process.exitCode ?? 0);

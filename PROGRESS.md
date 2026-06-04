<!-- @format -->

# PROGRESS.md — build log

The running log of how this project was built and evolved.
The agent appends an entry at the start and end of each phase (see `blueprint.md` §13).
Spec _changes_ go in the blueprint's Amendment log (§15); _build activity_ goes here.
Keep entries factual and terse.

---

## Format

```
### YYYY-MM-DD — Phase N: <name>
- Start: <what's about to be done>
- Decisions: <any choice made, deps added + why>
- Result: <acceptance criteria pass/fail, what's left>
```

---

## Log

### (seed) — Phase 0 not yet started

- Repo contains the ready-to-go scaffolding (blueprint, CLAUDE, README, .gitignore,
  .env.example, sync.config.example.json, this file).
  Agent begins at Phase 0 per `blueprint.md` §13.

### 2026-06-03 — Pivot: CLI bidirectional sync → local web UI for one-time Operations

- Human-directed scope change before any code was written.
  Authored as `blueprint.md` §15 amendment of the same date; rewrote §1, §3, §8, §9, §10,
  §11, §13, §14 to match.
- Tool's unit of work is now the **Operation**:
  `{source, destination, sourceTarget, destinationTarget}`, additive-only, run on-demand
  from the UI's Run button with live SSE status. The Spotify ↔ Apple bidirectional
  reconciliation model with `sync_pairs`/`baseline` three-way merge is deferred.
- Removed `sync.config.example.json` (operations are ad-hoc; pair config no longer exists).
  Removed `reports/` from `.gitignore` (no reports directory in v1; unmatched surfaces in
  the UI and in `operation_events`).
- Repo state heading into Phase 0: `blueprint.md`, `CLAUDE.md`, `README.md` (needs update
  for new UI surface — pending in Phase 0), `PROGRESS.md`, `.gitignore`, `.env`, and
  `.env.example` (still TBD — Phase 0). No source code yet.
- Next: Phase 0 scaffold per the revised §13.

### 2026-06-03 — Spec amendment: Permissions preflight gate

- Human-directed addition before any code was written.
  Authored as `blueprint.md` §15 amendment of the same date; updated §1 in-scope bullet,
  §3 (added `src/preflight/`), §9 (added `preflight_runs` + `preflight_checks` tables),
  §11 (added Permissions panel + endpoints + gating policy + `doctor` sharing the
  orchestrator), §13 (inserted new Phase 5; renumbered the rest), and §14.
- Behavior: 11-check sequence (env, both tokens, Spotify scopes, sample reads on each side,
  ISRC lookup, Apple delete-probe). Streams pass/warn/fail via SSE.
  Catalog refresh + Operation runs are disabled UI-side and 412-refused server-side until
  the latest preflight `passed`. Auto-invalidation on any downstream 401/403.
  No time-window expiry — re-check is cheap.
- The CLI `doctor` is now a thin surface over the same `preflight/runner.ts`;
  a CLI pass and a UI pass are interchangeable for gating.
- Phase plan grew from 8 → 9 phases.
  Phase 5 is now Permissions preflight; Catalog/UI is 6; Operation runner is 7;
  Polish is 8; Publish is 9.
- Next: still Phase 0 scaffold (no code yet); the preflight work lands in the new Phase 5.

### 2026-06-03 — Spec amendment: Preflight design tightened (validation pass)

- Human asked to deeply validate and resolve five open concerns I had raised against the
  previous preflight amendment, then commit and push.
  Authored as `blueprint.md` §15 amendment of the same date; updated §1, §6.2, §9, §11.1,
  §13 (Phase 5 AC rewritten), and §14.
- Resolutions:
  1. **Gate has a 24h soft expiry** in addition to the failure-based invalidation.
     Catches overnight drift (revoked Spotify auth, expired MUT) at the door rather than
     mid-Operation. Re-checks are cheap.
  2. **`apple_delete_probe` removed from v1 preflight.**
     v1 deletes nothing, so the probe is deferred along with removals;
     §6.2 now states this explicitly. Check list is 10, not 11.
  3. **Auto-invalidation is refresh-aware.**
     `util/http.ts` attempts one token refresh / dev-token re-sign + retry on 401;
     only the second 401 (or a 403 whose body indicates a scope problem, not rate-limit)
     writes an `invalidated` row.
     Trigger values: `'auto-401'` or `'auto-403-scope'`.
     Rate-limit 403s and transient 401s recovered by refresh do not invalidate.
  4. **`spotify_scopes` reads the persisted scope list from `data/tokens.json`**
     (captured from the OAuth `scope` response field).
     Spotify has no public token-introspection endpoint for PKCE clients —
     inventing one would violate the truthfulness invariant.
     The blueprint now calls this out so a future agent doesn't go hunting.
  5. **Ten checks remain fine-grained, presented in three UI groups**
     (Environment / Spotify / Apple).
     Env runs first; Spotify and Apple groups run in parallel;
     intra-group skips when a prerequisite fails.
- Phase plan unchanged (still 9 phases).
  Phase 5 AC rewritten as six numbered subcriteria so the agent has concrete pass/fail
  targets (e.g. "backdate `finished_at` to >24h → gate closes →
  POST /api/catalog/refresh returns 412").
- Next: Phase 0 scaffold per §13. After this docs commit lands, building begins.

### 2026-06-03 — Spec amendment: 6-persona validation pass → 8 amendments

- Human-directed. Ran multi-persona adversarial workflow `wf_cc3ea7a4-e8f`
  (security / API truthfulness / UX / architecture / coherence / build-readiness),
  6 personas in parallel, each finding individually verified by a refute-by-default
  adversarial verifier. Raw: 65 findings → 28 verified real → 0 blockers, 2 high,
  12 medium, 14 low. API-truthfulness persona's 9 findings all dropped by verifier
  (no live-doc drift surfaced).
- Resolved every verified finding with concrete spec edits across blueprint, README,
  and CLAUDE.md:
  1. **Fixed `SPOTIFY_REDIRECT_URI`** in §4 (was `/callback`, now
     `/auth/spotify/callback`); Phase 2 AC now asserts byte-equality across all four
     reference locations. This was the guaranteed first-run failure flagged by 3
     personas independently.
  2. **New §11.0 "Local-server security model"**: 127.0.0.1-only bind,
     Host/Origin validation on all routes, per-server-start CSRF token in HTML
     consumed via `X-CSRF-Token`, OAuth `state` + PKCE `code_verifier` in in-memory
     store with 10min TTL, Apple popup nonce binding `/start` to `/callback`,
     **short-lived (10min) developer token** for the browser so the 180-day JWT
     never leaves the server. Phase 1/2/3 ACs updated to land these in sequence.
  3. **Expanded §12 redaction list** (developerToken, OAuth code/access_token/
     refresh_token/state/code_verifier/nonce in bodies + query strings,
     BEGIN PRIVATE KEY pattern, configured Team/Key ID values, Set-Cookie/Cookie
     headers); **per-check `preflight_checks.detail` allow-lists** spelled out
     (`apple_dev_token` reports `alg`/`exp_days_remaining`/`signed` — never
     `iss`/`kid` since those equal Team ID / Key ID); **file permissions** 0600 on
     `.p8`, `tokens.json`, `ledger.sqlite*`; 0700 on `secrets/` and `data/`;
     verified at startup.
  4. **§9 + §12.5 hardening**: partial unique indexes
     `WHERE status='running'` on `operations` and `preflight_runs` (DB-level
     enforcement of "one at a time"); `finished_at` indexes for gate-query
     performance; `NOT NULL` constraints; `__liked__`/`__favorites__` sentinels for
     `catalog.external_id`; new `interrupted` status; **startup reconciliation
     sweep** marks stranded `running` rows as `interrupted`; **resume soundness
     union** uses `operation_events.write` rows (canonical) alongside destination
     read, eliminating the eventual-consistency duplicate-append risk.
  5. **Rematch fully wired** through §11.1 (Advanced toggle), §11.2 (POST body
     field), §12.5 (deletes cached `tracks` rows for source items before
     resolution), Phase 7 AC subcriterion (verified via `match` event with
     `from_cache: false`). Also: auto-revalidation when a cached target id 404s.
  6. **ISRC fixture sourcing for `apple_isrc_lookup`** specified in §11.1: derive
     at runtime from the resolved storefront's top chart (`/v1/catalog/{sf}/charts`),
     avoiding hardcoded fixtures that drift across storefronts and over time.
  7. **Free-text duplicate-name disambiguation** in §9: 0 matches → create (dest only);
     1 → auto-resolve; ≥2 → server returns 422 with candidate list, UI prompts
     disambiguation modal; Phase 6 AC covers the modal.
  8. **Coherence sweep + folded-in low-impact fixes**: §3 `sync.sqlite` →
     `ledger.sqlite`; §9 dropped `'warn'` status; README "Apple capability probes"
     line corrected; CLAUDE.md idempotency test moved Phase 6 → Phase 7; `.DS_Store`
     added to CLAUDE.md gitignore checklist. Also folded in SSE `Last-Event-ID`
     reconnect protocol (against `operation_events.seq`), UI poll-on-focus for gate
     state, event-log virtualization (cap at last 500 events + aggregate counters),
     popup-failure UX (10s grace), mid-Operation gate-invalidation behavior (current
     Operation continues, next blocked), WAL/foreign_keys/synchronous PRAGMAs,
     schema_version semantics, Phase 0 `npm run build` semantics.
- §14 done criteria add: §11.0 security model in place; crash-recovery (no orphaned
  `running` rows after restart); `doctor`-UI gate-state visibility.
- Phase plan unchanged (still 9 phases). Phase 1 grew to also include the §11.0
  security framework scaffold (CSRF, Origin/Host middleware, network bind).
- Spec is now at **READY TO BUILD** per the validation report's verdict bar; no
  known gaps that would cause first-run failure or guaranteed mid-build amendments.
- Next: Phase 0 scaffold per §13.

### 2026-06-03 — Phase 0: Scaffold

- Start: create `package.json`, `tsconfig.json`, ESLint/Prettier configs, `.env.example`,
  `web/index.html` placeholder; confirm `.gitignore` is complete; verify `npm install` +
  `npm run build` (tsc on empty `src/`) exit 0; confirm secrets audit clean.
- Decisions:
  - `package.json` is `type: "module"` (ES modules per global instructions); scripts
    `build` (`tsc --noEmit`), `start` (`tsx src/server.ts`), `doctor`
    (`tsx src/cli.ts doctor`), plus `lint`/`format`. Engines pin Node ≥ 20.
  - Dependencies match blueprint §2: `better-sqlite3`, `dotenv`, `jsonwebtoken` as
    runtime deps; `tsx`, `typescript`, `eslint`+`@typescript-eslint`, `prettier`,
    `@types/node`, `@types/jsonwebtoken` as dev. No `axios`, no `express` — built-in
    `fetch` + `http`.
  - `tsconfig.json` per §13: `strict`, `target: ES2022`, `lib: ['ES2023']`,
    `module/moduleResolution: NodeNext`, `noUncheckedIndexedAccess`. Added
    `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules` for stricter
    type hygiene up front — cheap to enforce now, expensive to bolt on later.
  - Prettier `proseWrap: preserve` per §13 (matches the `<!-- @format -->` directive in
    tracked docs). ESLint configured via `.eslintrc.cjs` (legacy config) to dodge the
    flat-config / `type: module` interaction; this is Phase 0 scaffolding, not load-
    bearing.
  - Added a tiny `src/server.ts` stub (`export {};`) because modern `tsc` errors out on
    truly empty input (`TS18003`). The blueprint AC phrases this as "tsc on no input is
    a no-op"; the stub is the literal minimum to satisfy that intent. Phase 1 overwrites
    it with the real entrypoint.
  - `web/` placeholder is three files (`index.html`, `app.css`, `app.js`) so the Phase 1
    static handler has something to serve from day one.
- Result: AC met.
  1. `npm install` ✅ (187 packages, 0 vulnerabilities).
  2. `npm run build` ✅ (exits 0; tsc finds the stub, no errors).
  3. `git status` shows only the Phase 0 scaffold staged; `.env`, `node_modules/`,
     `data/`, `secrets/`, `*.p8`, `tokens.json` all confirmed gitignored.
  4. Secrets audit on the staged diff: no `BEGIN PRIVATE KEY`, no bearer-looking
     strings, no `sk_live`/`sk_test` matches.
  5. `sync.config.example.json` was already removed by the 2026-06-03 pivot
     amendment — nothing to delete.
- Next: Phase 1 — ledger schema + HTTP server skeleton + §11.0 security framework
  (127.0.0.1 bind, Host/Origin middleware, CSRF token, startup reconciliation sweep).

### 2026-06-03 — Phase 1: Ledger + HTTP server skeleton + security framework

- Start: implement `src/config.ts` (env load + validate), `src/util/log.ts` (redaction
  skeleton per §12), `src/ledger/db.ts` (§9 schema + WAL/foreign_keys/synchronous PRAGMAs
  + forward migration runner + §12.5 startup reconciliation sweep + file-perm hardening),
  `src/http/server.ts` (built-in `http`, bound to 127.0.0.1:8888 only; Host check on all
  routes; Origin + X-CSRF-Token check on POSTs; per-server-start CSRF token injected as
  `<meta name="csrf-token">`; static handler for `web/`; `GET /api/health`), and
  `src/server.ts` entrypoint that wires them.
- Decisions:
  - `config.ts` exposes both `checkEnv()` (soft predicate, used by the future preflight
    `env` check) and `loadConfig()` (throws on missing keys, used by code paths that
    cannot run without creds). Constants centralize the redirect URI and Host/Origin
    strings so the §4 byte-equality check Phase 2 enforces is a literal `===` against
    `SPOTIFY_REDIRECT_URI_EXPECTED`.
  - `util/log.ts` captures `APPLE_TEAM_ID` / `APPLE_KEY_ID` at module init for redaction
    (per §12). Note the ordering caveat: the logger must be imported _after_ `dotenv` —
    in practice that's already true because every entry point goes through `config.ts`
    first (which calls `loadDotenv()`), then anything else.
  - `ledger/db.ts` keeps migrations as a numbered map and runs them in version-numbered
    transactions; the upsert of `schema_version` lives inside the transaction so a
    crash mid-migration leaves the DB at the previous version (the next run replays).
    The startup sweep is a separate transaction so its own logging never overlaps a
    migration's; both the `operation_events` `interrupted` append and the row update
    happen atomically. WAL + `synchronous=NORMAL` per §9; foreign_keys forward-investment.
  - `http/server.ts` uses a simple route-table dispatcher rather than a router lib;
    Phase 2+ phases register routes via the exported `route()` helper, keeping the
    middleware (Host / Origin / CSRF) in one place. The CSRF token rotates per
    server-start, is base64url(32 random bytes), and is injected into HTML by
    `http/static.ts` via a `<meta>` tag rewrite — no separate template engine. POST
    `/api/health` exists only as the Phase 1 AC fixture for CSRF/Origin enforcement.
  - File-perm hardening (0700 on `data/`, 0600 on `ledger.sqlite*`) runs both before
    and after migrations because WAL files come into existence with the first write.
- Result: AC met.
  1. `npm start` boots: `data/ledger.sqlite` created at mode `0600`, `data/` at `0700`,
     `schema_version` row = `1`, every §9 table + index present (verified via
     `sqlite_master`). ✅
  2. `GET /api/health` from `127.0.0.1:8888` → `200 {"ok":true}`; the same request to
     `localhost:8888` → `403 host_header_invalid` (Host mismatch). ✅
  3. `POST /api/health` without `X-CSRF-Token` → `403 csrf_token_invalid`; with a wrong
     token → `403 csrf_token_invalid`; with the served token (extracted from
     `<meta name="csrf-token">`) + correct Origin → `200 {"ok":true,"method":"post"}`;
     with correct CSRF but wrong Origin → `403 origin_invalid`. ✅
  4. Seeded a `running` `operations` row + a `running` `preflight_runs` row, restarted
     the server, observed `ledger.reconciled_stranded_running` log line with
     `{operations:1, preflight_runs:1}`. Both rows now `interrupted` with
     `finished_at` set; the operation has a final `operation_events` row of type
     `interrupted` with payload `{"reason":"server_restart_during_run"}`. ✅
- Deps added: `@types/better-sqlite3` (dev) — required by the strict tsconfig once
  `better-sqlite3` is imported. Counts as part of the §2 standard dev tooling.
- Next: Phase 2 — Spotify PKCE flow, the §11.0 OAuth `state` + `code_verifier` store
  with 10-minute TTL, refresh handling, read client, and Spotify Connect button
  reaching ⏸A / ⏸B.

### 2026-06-03 — Phase 2: Spotify auth + read

- Start: implement Spotify PKCE flow end-to-end — `src/util/http.ts` (fetch wrapper with
  backoff + Retry-After), tokens store at `data/tokens.json` (0600), `src/auth/spotify.ts`
  (PKCE gen + 10-min state store + token exchange persisting `scope` + refresh-on-expiry
  per §11.0 / §5.1), `src/clients/spotify.ts` (read client: profile, playlists, playlist
  tracks, Liked with pagination + ISRC), HTTP routes `POST /api/auth/spotify/start`,
  `GET /auth/spotify/callback` (Origin-exempt; state-validated), `GET /api/auth/status`,
  a minimal "Connect Spotify" UI button driving the popup, and an inline unit test
  enforcing byte-equality of `SPOTIFY_REDIRECT_URI` across `.env.example`, the start-URL
  builder, and the callback route registration (Phase 2 AC #2). Then PAUSE at ⏸A with
  copy-pasteable Spotify Dashboard instructions; resume for ⏸B (consent in the UI).
- Decisions:
  - `util/http.ts` ships with the §12 backoff + Retry-After honor + jitter and a hook
    point (`onUnauthorized`) for the Phase 5 refresh-aware auto-invalidation logic. Phase
    2 itself never uses the hook (the auth-flow exchanges have no token yet to refresh).
  - `auth/tokens.ts` writes atomically (temp + rename) at mode 0600 to avoid torn reads
    if the process is killed mid-write. The schema is permissive — Spotify and Apple
    each own a slice — so Phase 3 just adds an `apple` key alongside.
  - `auth/spotify.ts`'s state store is in-memory only, per-server-start, with a 60s
    sweeper that drops entries older than 10 min. The map's TTL check on lookup is the
    primary defense; the sweeper just keeps memory bounded. `code_verifier` is 96 bytes
    of randomness → 128 base64url chars, the high end of RFC 7636's allowed range.
  - `clients/spotify.ts`'s pagination caps at 200 pages × 50 items = 10k items per
    collection. A personal library that exceeds this should be the rare case; the cap is
    a runaway-loop backstop rather than a real product constraint.
  - `routes_auth.ts` keeps the callback `GET` route on the server's normal dispatcher;
    Origin/CSRF middleware is POST-only, so the GET callback is correctly exempt by
    construction (no special-case code path). The `handleCallback` function validates
    `state` exactly the way blueprint §11.0 requires — unknown → 403 + body
    `state_unknown`; expired (>10 min) → 403 + body `state_expired` AND entry purged.
  - The Phase 2 AC #2 byte-equality test (`src/auth/spotify.test.ts`) reads
    `.env.example` from disk, parses the redirect_uri out of `buildAuthorizeUrl()`'s URL,
    greps the routes file for the literal `"/auth/spotify/callback"`, and compares all
    three against `SPOTIFY_REDIRECT_URI_EXPECTED` from `config.ts`. Running `.env` is
    intentionally NOT compared (a) because it's gitignored and may be empty in CI, and
    (b) because the four "reference locations" the blueprint cites are really
    `.env.example` (template), the expected constant, the start-URL, and the callback
    route — the runtime `.env` is the user's value, which is enforced separately by
    `loadConfig()` and the Phase 5 `env` preflight check. All five assertions pass.
  - The Phase 2 AC #3 state-validation tests run inline alongside AC #2.
  - UI auth panel is intentionally tiny: a single Connect Spotify button, a popup
    watcher, and a 10s grace timer per blueprint §11.1's popup-failure UX. Apple is
    rendered as a placeholder until Phase 3.
- Result so far: AC #2 ✅ (5 assertions), AC #3 ✅ (3 assertions), live smoke against the
  Phase 1 server: `/api/auth/status` returns `{spotify:{connected:false}, apple:{connected:false}}`;
  `POST /api/auth/spotify/start` correctly fails with `Missing required env vars: …` (named,
  actionable) until ⏸A is resolved; callback with unknown state → 403; callback with
  missing state → 400. AC #1 (live Spotify connect) requires ⏸A + ⏸B and is what the
  human is unblocking next.
- ⏸A + ⏸B done. Notes from the live flow:
  - Safari blocked the callback navigation with "Use HTTPS-Only" enabled (WebKitErrorDomain:305).
    Spotify followed RFC 8252 and allowed the loopback HTTP redirect, but Safari's privacy
    default rejects it. Working in Chrome was the easy fix. README should call this out
    in Phase 8 polish.
  - Split `loadConfig()` into `loadConfig()` + `loadSpotifyConfig()` + (placeholder for
    `loadAppleConfig()`) so callers between ⏸B and ⏸C don't fail just because Apple's keys
    are absent. The full `loadConfig()` is now only used at sites that need both platforms.
- AC #1 live verification (ephemeral script, deleted after run):
  - All 6 required scopes captured and persisted in `data/tokens.json`.
  - `GET /v1/me` ✅; `GET /v1/me/playlists` returned 11 playlists (7 owned, 4 followed);
    `GET /v1/me/tracks` returned 1623 saved tracks with 5/5 ISRCs on the sampled head;
    `GET /v1/playlists/{id}` (via the workaround below) returned 2 tracks for "Video Hard 🎬"
    with 2/2 ISRCs.
- **Spotify API drift surfaced during AC #1 — recorded here, will harden in Phase 5/7.**
  Two concurrent changes Spotify rolled out that aren't in the blueprint's §6 priors:
  1. `GET /v1/playlists/{id}/tracks` returns **403 Forbidden** for apps in Development
     Mode quota, even on the owner's own playlists, with the correct scopes (verified:
     `/v1/playlists/{id}` → 200 with full metadata for the same id with the same token;
     only the `/tracks` subpath is restricted). Likely a side-effect of the late-2024
     "Extended Quota Mode" rollout (https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api).
  2. **Schema rename on the playlist object**: the field formerly known as `tracks` is now
     `items` on `/v1/playlists/{id}`, and within each playlist-track entry the inner
     field formerly `track` is now `item`. The legacy names still work on `/v1/me/tracks`
     (Saved/Liked), so for now the client extracts both shapes.
  Workaround in `listPlaylistTracks`: fetch the parent endpoint
  `/v1/playlists/{id}?market=from_token` and walk `items.items[].item` (with `.track`
  fallback). Pagination uses `items.next`, which may point back at the restricted
  `/tracks` endpoint and 403 — confirmed once a playlist exceeds 50 items, this needs a
  Phase 7 workaround (likely re-fetching the parent with `?offset=...&fields=items(...)`).
  Documented in `src/clients/spotify.ts` listPlaylistTracks doc comment.
- Phase 5 preflight will add a `spotify_playlist_tracks` probe that exercises this path
  on the user's own playlist and surfaces the drift to the user with a clear remediation
  pointer (Extended Quota Mode application, OR add user in App User Management).
- Result: Phase 2 AC #1 ✅, AC #2 ✅, AC #3 ✅. Phase 2 done.

### 2026-06-04 — Spotify drift correction (was wrong yesterday; the right story)

- Yesterday's PROGRESS entry attributed the `/v1/playlists/{id}/tracks` 403 to
  "Development-Mode quota" with concern about pagination beyond 50 items. **That was
  wrong.** After a second probe, the actual story is much simpler — Spotify executed
  a consistent rename across the playlist surface:
  - field `tracks` → `items` on the playlist object (both list + detail endpoints)
  - subpath `/tracks` → `/items` on the URL
  - inner field `track` → `item` on each PlaylistTrackItem
  The legacy `/tracks` endpoint now returns 403 (not deprecated to 404 — actively
  rejected, presumably to push clients off the legacy URL); the new `/items` endpoint
  takes the same `limit`/`offset`/`market`/`fields` query params and returns the same
  Page<T> shape. There is no quota issue, no Extended Quota Mode needed, no Phase 7
  hardening risk for normal-sized playlists.
- `src/clients/spotify.ts` cleanup:
  - `SpotifyPlaylistSummary` now accepts `items?: {total, href}` (new) and `tracks?: {total, href}` (legacy fallback); helper `playlistTrackCount` reads either.
  - `listPlaylistTracks` now hits `/v1/playlists/{id}/items?limit=50&market=from_token`
    directly and paginates via the response's `next` URL — same simple shape as
    `listSavedTracks` and `listMyPlaylists`. Code is back to the standard pattern.
  - `extractTrack` kept to absorb the `item` vs `track` field name across surfaces.
- Live re-verification (ephemeral script, deleted): all 7 owned playlists read end-to-end,
  declared totals match read totals exactly, **534/534 tracks have ISRCs**. Sweat (308),
  India Spice (123), Sangeet (49), Pithi & Haldi (25), Baraat (16), Garba (11),
  Video Hard (2). Pagination across the 308 and 123-track playlists exercised. Liked
  Songs still works at 1623 tracks. AC #1 is now unambiguously satisfied.
- README updated with a Safari/HTTPS-Only troubleshooting note under Setup.
- No blueprint amendment needed — the renames are implementation-tier drift the client
  now handles, not a spec change. §6 (API hazards) is Apple-side; the Spotify rename
  is exactly the kind of drift the §0 "self-healing" principle anticipates.
- Next: Phase 3 — Apple Music auth (dev-token JWT + MusicKit MUT capture), with ⏸C
  (Apple Developer setup) and ⏸D (consent in the UI).

### 2026-06-04 — Phase 2 final close-out + dev script

- Closed every leftover from yesterday's wrap-up. None were AC blockers, but worth
  pinning down so Phase 3 starts on a clean floor:
  1. **AC #2 fourth assertion landed.** `.env`'s `SPOTIFY_REDIRECT_URI` byte-equality
     is now asserted by the test when `.env` is present and the line has a value;
     guarded with a SKIP on a fresh clone (where `.env` is gitignored / absent). On
     this machine: PASS.
  2. **AC #2(e) defense-in-depth assertions** — the authorize URL contains all 6
     required scopes, uses S256, and has a ≥32-char state. Catches silent regressions
     where someone accidentally weakens the flow.
  3. **AC #4 sweeper test** — extracted the sweep logic into `sweepExpiredStates()`,
     added a `__test.runSweep` hook, and seeded 4 entries spanning fresh / <10min /
     11min / 1h to verify the partition is exactly right (2 purged, 2 retained), the
     log line fires only when `purged > 0`, and a second sweep is idempotent. 7 new
     assertions, all PASS. Total suite is now 21/21 PASS.
  4. **`util/http.ts onUnauthorized` left stubbed.** Per blueprint §13 the refresh-
     aware auto-invalidation lands in Phase 5; leaving the passthrough is on-spec.
  5. **Live Reconnect verified.** Stopped the stale pre-`loadSpotifyConfig` server,
     started fresh, POST'd `/api/auth/spotify/start` — returns a clean authorize URL
     with a new state, S256 challenge, response_type=code, even though Apple keys are
     empty. The split was the right call.
  6. **Popup-failure UX path** — code path in `web/app.js` (popup-null → setMessage
     "blocked"; popup closed before callback → 10s grace then "did not complete"). Not
     auto-tested (browser-side; no headless browser in v1). Reviewed by reading;
     correct per blueprint §11.1.
- **Dev helpers landed.** `scripts/dev.sh {stop|status|restart}` exposed as
  `npm run stop|status|restart`. `stop` SIGTERMs every process matching
  `tsx src/server.ts`, waits up to 5s for port 8888 to free, then SIGKILLs the holdouts.
  `restart` stops then `exec`s `npm start` (foreground). README's Setup section now
  documents the helpers. Verified end-to-end on this machine: stop killed the stale
  9h-old server cleanly; status reported correctly before/after; fresh start picked up
  the `loadSpotifyConfig` fix.
- Test count: **21/21 PASS** (AC2 a–e ×8, AC3 a–b ×4, AC4 sweeper ×9 — and the AC2(d)
  `.env` SKIP path covered separately on a fresh clone).
- **Phase 2 is now fully closed.** No deferred work that should have landed here.

### 2026-06-04 — Phase 3: Apple Music auth + read

- Start: implement `loadAppleConfig`, `src/auth/apple.ts` (ES256 JWT signing from the `.p8`,
  long-lived 180-day server-side token cached + auto-regenerated within 7d of expiry per
  §5.2, **short-lived 10-min token minted per popup** per §11.0, nonce store with 10-min
  TTL + 60s sweeper), `src/clients/apple.ts` (storefront resolution, library playlists +
  tracks, library songs, catalog search, ISRC lookup), `web/musickit.html` (popup loads
  MusicKit JS v3, configures with short-lived token, calls `authorize()`, POSTs `{nonce,
  mut}` to `/api/auth/apple/callback`), HTTP routes `POST /api/auth/apple/start` and
  `POST /api/auth/apple/callback`, a Connect Apple Music UI button, AC #2 + AC #3 unit
  tests. Then PAUSE at ⏸C (Apple Developer setup) with copy-pasteable instructions;
  resume for ⏸D (UI consent) to verify AC #1 live. Apple delete-capability probe is
  **deferred** per the 2026-06-03 amendment.
- Bugs found and fixed during ⏸C/⏸D run:
  1. **Test pollution in `apple.test.ts`**: AC #3(d) called `handleCallback` with a
     fake MUT, which wrote `"test-mut-value"` to the real `data/tokens.json` and
     left the UI showing "Apple connected" with junk. Patched: test snapshots
     `data/tokens.json` before importing `apple.ts` and restores it via a
     `process.on("exit", …)` hook (also handles SIGINT). Without this, repeated
     `npm test` runs silently corrupted the user's auth state.
  2. **`secrets/` directory at `0755`**: blueprint §12 requires `0700`. The
     loadPrivateKey path now tightens the parent dir to 0700 alongside the
     existing .p8 → 0600 chmod. Verified: `drwx------ secrets/` after first read.
  3. **CSRF meta tag NOT injected into `musickit.html`**: the static handler's
     substring check `body.includes('name="csrf-token"')` matched the JS in the
     popup that READS the tag (`document.querySelector('meta[name="csrf-token"]')`),
     then ran a regex replace that found no actual `<meta>` and silently did
     nothing. Every popup POST then 403'd as `csrf_token_invalid`. Patched: the
     detection now uses a proper regex `/<meta\s+[^>]*\bname=["']csrf-token["']/`
     that matches only an actual `<meta>` tag. Fix verified by re-curling both
     `/` and `/musickit.html` — both now show the same per-server-start token.
  4. **Stuck "Opening Apple Music authorization…" UI message**: the popup-watch
     grace check hardcoded `spotifyStatusEl`, so after a successful Apple
     connect the success path didn't clear the in-flight message. Patched: the
     watcher now takes a `platform` arg and (a) clears the message when the
     correct platform's status flips to connected, (b) checks the right element
     in the 10s "did not complete" grace.
  5. **`getTopChartSongs` parsed one extra `data[0]`**: actual shape is
     `j.results.songs` is an **array** of chart containers; the songs live at
     `[0].data`. Was reading `[0].data[0].data`. Fixed.
- Live AC #1 verification (ephemeral script, deleted after run):
  - **Storefront**: `us` resolved via `/v1/me/storefront`. ✅
  - **Library playlists**: 27 playlists fetched. 4 editable (incl. "India Spice 🌶️",
    "Sweat 🦾", "My Shazam Tracks", "GarageBand"). 23 read-only (Apple Music's
    curated "Bollywood Chill", etc.). ✅
  - **Library playlist tracks**: 118 tracks read from "India Spice 🌶️" via
    `/v1/me/library/playlists/{id}/tracks`. ✅
  - **Library songs**: 2 entries (GarageBand demos). ✅
  - **ISRC lookup**: top chart song (Drake's "Janice STFU", ISRC USUG12604763)
    derived dynamically per §11.1, then looked up via
    `/v1/catalog/us/songs?filter[isrc]=USUG12604763` → 1 validated candidate. ✅
- **Real finding for Phase 4 (matching engine).** Library-track responses
  (`/v1/me/library/playlists/{id}/tracks` and `/v1/me/library/songs`) do NOT
  expose `isrc` directly — the library object is a wrapper around a catalog
  song, and the ISRC lives on the underlying catalog record. The matcher will
  need either `?include=catalog` on library reads or a `playParams.catalogId`
  → `/v1/catalog/{sf}/songs/{id}` follow-up hop. Catalog ISRC lookups (which
  is what Tier-1 matching does in the Spotify→Apple direction) are unaffected.
- **GarageBand pseudo-playlist** in Apple's library returns 404 on `/tracks`;
  Phase 7's source-resolver should skip playlists named "GarageBand" (and
  perhaps any with `playParams.kind === "library-recordings"`) to avoid
  surfacing them as transfer sources. Noted.
- Result: Phase 3 AC #1 ✅ (live), AC #2 ✅ (unit, popup JWT ES256/kid/iss +
  TTL ≤ 605s + long-lived TTL ∈ (30d, 181d]), AC #3 ✅ (unit, nonce lifecycle
  + single-use), AC #4 ✅ (unit, sweeper). **Total suite: 45/45 PASS**.
  Apple delete-capability probe deferred per 2026-06-03 amendment.
- Phase 3 done. Next: Phase 4 — matching engine (`identity.ts` + `scoring.ts`
  + `matcher.ts`), ledger-backed cache. No pause points. Will land the
  `?include=catalog` / `catalogId`-lookup hop for library-side ISRCs as part
  of the Apple-side matcher.

### 2026-06-04 — Validation sweep: 5 personas → 25 confirmed findings → fixed

- Triggered a multi-persona deep validation pass before starting Phase 4. Ran a Workflow
  with 5 reviewers (security, API truthfulness, architecture, regression / build-readiness,
  blueprint compliance) in parallel, each emitting structured findings, then an adversarial
  refute-by-default verifier on each finding individually. 49 raw → **25 confirmed**
  (4 high, 9 medium, 12 low; #3 and #10 were the same bug → 23 unique).

- **Tier 1 — Security highs.**
  1. **#1 Stored XSS in Spotify OAuth callback.** `?error=<script>…` was echoed unescaped
     into the auto-close HTML via `sendAutoCloseHtml`. Single cross-origin top-level
     navigation → script execution in trusted local origin → CSRF token theft → drive any
     POST. Fixed: `sendAutoCloseHtml` now HTML-escapes its `message` argument; the Spotify
     callback no longer echoes `errParam` at all (fixed string instead, raw error logged
     server-side); CSP `default-src 'none'; style-src 'unsafe-inline'; script-src
     'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'` on the auto-close page;
     X-Frame-Options: DENY. Regression covered by new `src/http/server.test.ts`.
  2. **#24 `src/util/log.test.ts` missing.** Blueprint §12 literally mandates it. Wrote
     comprehensive coverage: every header in REDACTED_HEADER_NAMES, every body key in
     REDACTED_BODY_KEYS (with `mut` added), Bearer 40+ regex, BEGIN PRIVATE KEY block,
     redactUrl per blueprint §12 (query-param redaction), case-sensitivity audit. 39
     assertions.
  3. **#23 URL query strings logged verbatim.** Blueprint §12 requires query params with
     sensitive names to be redacted. Added `redactUrl()` in util/log.ts; all `req.url`
     usages in util/http.ts now route through it; tested.
  4. **#25 `mut` body key missing.** The wire JSON for `/api/auth/apple/callback` uses
     `mut`, not `musicUserToken`, so the existing redaction missed it. Added.

- **Tier 2 — Token/refresh robustness.**
  5. **#3/#10 Spotify refresh-token rotation race.** Concurrent `getAccessToken()` calls
     would each enter `refreshAccessToken` with the same `refresh_token`; Spotify rotates
     on use, so the losers retry with the now-invalidated token. Fixed: single in-flight
     promise (`refreshInFlight`); `refreshAccessToken` returns the same promise to all
     callers and clears it in `.finally`. Critical before Phase 4 (matcher fans out
     parallel catalog reads).
  6. **#12 storefrontCache never invalidates on Apple reconnect.** US → JP account switch
     would keep the old storefront cached. Fixed: cache is now keyed on the MUT prefix so
     a different MUT auto-invalidates. Avoids the circular import that explicit
     invalidation from `auth/apple.ts` would have introduced.
  7. **#16 apple.test.ts pollution edge case.** Snapshot/restore only restored when
     `data/tokens.json` existed beforehand; on a fresh clone the test created the file
     with a junk MUT and the restore hook didn't `unlinkSync` it. Fixed: restore now
     mirrors the original presence/absence state.
  8. **#9 / #13 Apple library reads omit `include=catalog`.** Library-track responses
     don't expose ISRC directly; without `include=catalog` the matcher has no way to
     round-trip back to the catalog song. Fixed: every library read now sends
     `&include=catalog`; new `libraryIsrc()` and `libraryCatalogId()` helpers read the
     embedded relationship with `attributes.isrc` / `playParams.catalogId` fallbacks.
     Live verified against your "India Spice 🌶️" playlist: **98/118 ISRCs + 117/118
     catalog IDs surface (was 0/118)**.

- **Tier 3 — API correctness.**
  9. **#8 `searchByIsrc` truncates results.** Per-chunk requests pushed only the first
     page and ignored `next`. A single ISRC can match multiple catalog entries (single /
     deluxe / regional masters / compilation appearances); the matcher would silently
     lose disambiguation candidates. Fixed: each chunk now routes through `paginate()`
     with `&limit=100`.

- **Tier 4 — Build hygiene + Phase 1 AC tests.**
  10. **#17 `npm run doctor` → ENOENT.** Phase 5 owns the real implementation; until
      then a tiny `src/cli.ts` stub exits 2 with "not implemented yet (Phase 5)" so
      anyone following README sees a clear pointer instead of a tsx module error.
  11. **#18 `npm run lint` fails out of the box.** Dropped unused `SPOTIFY_REDIRECT_URI_EXPECTED`
      import in spotify.ts; removed `LibraryPlaylistsResponse` and `CatalogSongsResponse`
      types that were no longer referenced after switching to inline `paginate<T>` types.
      `npm run lint` now exits 0.
  12. **#19 Phase 1 AC #2 + #4 had no automated coverage.** PROGRESS claimed both were
      verified, but only manually. Wrote `src/http/server.test.ts` (raw TCP socket to
      exercise Host=localhost rejection that fetch can't reach; CSRF + Origin matrix;
      XSS regression with CSP header check — 10 assertions) and `src/ledger/db.test.ts`
      (schema version + tables + partial-unique indexes + startup-sweep marks running
      → interrupted + appends event row + idempotency — 18 assertions). Both wired
      into `npm test`. **Total suite: 112/112 PASS** (log 39, spotify 21, apple 24,
      http 10, ledger 18).

- **Tier 5 — Defense-in-depth + lows.** Fixed every remaining low individually:
  - **#2 HttpError.bodySafe → body** (renamed), and the body + URL pass through `redact()`
    and `redactUrl()` so error messages embedded in logs are safe to forward.
  - **#4 state/nonce stores capped at 10k entries** with oldest-first eviction. Defense
    against a misbehaving caller exhausting RAM between sweeps.
  - **#5 auto-close HTML now ships strict CSP + X-Frame-Options: DENY** (covered by #1).
  - **#6 secrets/ chmod failure now logs loudly** instead of silently best-effort.
  - **#7 oversize POST → 413, not 500.** Renamed the body-parser error to
    `BodyTooLargeError`; route handlers re-throw it so the global handler maps to 413.
    Body parser no longer destroys the request mid-stream (was causing ECONNRESET
    instead of a clean response). Verified live with a 1.2 MB body → `{"error":"body_too_large"}`.
  - **#11 HttpError.isNetworkError flag** disambiguates real `status=0` from a
    retry-pool-exhausted network failure.
  - **#14 dead `loadConfig()` removed.** Every call site uses `loadSpotifyConfig` /
    `loadAppleConfig`.
  - **#15 .p8 cache invalidates on file change.** Cache key combines path + mtimeMs.
    Rotating the .p8 in place via the Apple Developer dashboard is now picked up on the
    next call without restarting the server. Also invalidates the cached long-lived JWT
    so the next sign uses the new key material.
  - **#20 `resolveSafe` no longer crashes on malformed `%`** — returns undefined → 404.
  - **#21 `dev.sh stop` won't kill someone else's `tsx src/server.ts`** — match is now
    anchored to this repo's absolute path.
  - **#22 web/app.js null-check on CSRF meta** — a regression in the static handler
    no longer wedges the whole script with a TypeError.

- Lint: clean. Build: clean. Tests: **112/112 PASS, 0 FAIL** across 5 suites. Live boot
  verifies auth status, XSS fix, and 413 path all work end-to-end.

- **Phase 4 (matching engine) starts on a clean floor.** Ready to go.

### 2026-06-04 — Phase 4: Matching engine

- Start: implement `src/match/identity.ts` (normalize / stripFeatured / normIsrc /
  identityKey / VARIANT_TOKENS), `src/match/scoring.ts` (§7 rubric — +40 title / +30
  primary artist / +15 duration / +10 explicit / +5 album / -25 per unwanted variant
  token; threshold 70), `src/clients/spotify.ts` additions
  (`searchTracksByIsrc`, `searchTracks`), `src/match/matcher.ts` (tiered match both
  directions with deterministic ISRC disambiguation: album match → non-compilation →
  first validated), and `src/ledger/tracksCache.ts` (get/put/delete against the §9
  `tracks` table). Phase 4 has no pause points.
- Decisions:
  - `CanonicalTrack` is the platform-agnostic shape both directions share. Optional
    fields declared `T | undefined` (not bare `T?`) because the strict
    `exactOptionalPropertyTypes` is hostile to spreading undefineds otherwise — most
    upstream tracks legitimately have missing ISRC / duration / explicit. Adapters
    `spotifyToCanonical` / `appleCatalogToCanonical` convert; the matcher's Tier-1
    candidates from the live API are also flattened to canonical so disambiguation
    can compare apples-to-apples.
  - Disambiguation rule from §7 implemented in `disambiguateIsrcCandidates`: source-
    album exact match wins → first non-compilation (regex against "greatest hits",
    "best of", "essentials", etc.) → first validated. Deterministic; same inputs
    always pick the same candidate so re-runs of the same Operation are stable.
  - The fuzzy fallback identity key uses 2-second duration buckets so ±1s upstream
    jitter still collides. Buckets are intentionally coarse — fuzzy is for the
    cache, not for selection (which is the matcher's job).
  - **Spotify search quirk discovered live**: `GET /v1/search?q=isrc:CODE&type=track`
    rejects `limit > 1` with `400 Invalid limit` (verified across `limit=20`,
    `limit=1`, omitted). Omitting the param works and returns Spotify's default,
    which is sufficient since `isrc:` queries return at most a small number of
    candidates anyway. Documented inline.
  - `tracksCache.ts` uses `ON CONFLICT(identity_key) DO UPDATE` with `COALESCE` on
    the Spotify/Apple ids so the cache row preserves whichever side wasn't part of
    the current match direction. This will matter in Phase 7 when an Apple→Spotify
    match for a track that already had a Spotify→Apple cache entry should add the
    spotify_id without clobbering the existing apple_catalog_id.
  - Pre-existing `util/http.ts` improvements (HttpError now passes the body through
    `redact()` and the URL through `redactUrl()`) mean Phase 4's logging surface is
    already secrets-clean. No new redaction work needed.
- Result: **all 4 Phase 4 AC sub-criteria PASS live**.
  - **#1a Tier-1 explicit master via ISRC** — Drake's "Dust" (Spotify, ISRC
    USUG12602488, explicit=true) → Apple catalog id 6769568594, dest_explicit=true,
    confidence 100. The matcher correctly picks the explicit master via ISRC, not a
    clean variant.
  - **#1b No-ISRC fuzzy track** — Same Drake track with ISRC blanked → Tier-2
    scored search → matches the same Apple catalog song with confidence 100.
    Tier-2 path exercised end-to-end.
  - **#1c Symmetric Apple → Spotify** — Apple's "Janice STFU" (ISRC USUG12604763)
    → Spotify track id 514joG57v4yKTsfQmz7stz via Tier-1 ISRC.
  - **#1d Ledger cache** — Repeat call returns `fromCache=true`; the persisted
    row in `tracks` has the resolved mapping.
- Unit coverage in `src/match/match.test.ts`: **42 assertions** covering normalize /
  stripFeatured / normTitle / normArtist / normIsrc / durationsClose / variantTokens
  / identityKey, score rubric for perfect / wrong-artist / wrong-duration /
  explicit-mismatch / remix-penalty / featured-drift, plus matcher cache hit and
  adapter coverage. Test snapshot-restores `data/ledger.sqlite` so it never leaves
  pollution on disk.
- **Total suite: 154/154 PASS** across 6 suites (log 39, spotify 21, apple 24,
  http 10, ledger 18, match 42). Lint clean. Build clean.
- Next: Phase 5 — Permissions preflight + gate. The new client primitives
  (`searchByIsrc`, `searchCatalog`, `getTopChartSongs`, `searchTracksByIsrc`,
  `searchTracks`) give the preflight runner everything it needs for the
  `spotify_search` and `apple_isrc_lookup` checks.

### 2026-06-04 — Phase 4 validation sweep: 25 confirmed findings → fixed

- Ran a 5-persona deep validation (security, API truthfulness, architecture, regression,
  blueprint compliance) over Phase 4 + its deltas, each finding adversarially verified.
  33 raw → **25 confirmed** (5 high, 11 medium, 9 low). After dedup ≈18 unique. All
  addressed; the sweep also caught one of its OWN recommendations being wrong (see #6).

- **Matcher correctness (Tier A):**
  - **#12/#24 (HIGH) Tier-1 never validated candidates.** §7 requires "first _validated_
    (non-404, fully-attributed)". Added `isValidatedCandidate` (non-empty title + artist +
    durationMs > 0); `disambiguateIsrcCandidates` now filters to validated candidates
    first and returns undefined when none validate (caller falls through to Tier-2 rather
    than returning a stub `data[0]`). Exported both for tests.
  - **#11/#19 (HIGH) cacheHit reconstructed destination from source-side + sqlite null.**
    sqlite returns SQL NULL as JS `null`, which violated the `string | undefined` field
    types; added an `nn()` coercion at the read boundary. Documented that
    `destination.canonical` on a cache hit carries NORMALIZED identity fields (not display
    strings) and that Phase 7 must use `destination.id` + the destination set `D` for
    display, never these fields.
  - **#2 (MEDIUM) fuzzy-key cache poisoning.** Two distinct recordings can share a
    `fuzzy:<title>|<artist>|<bucket>` key. `cacheHit` now re-verifies stored
    norm_title/norm_artist/duration against the live source for fuzzy keys; a mismatch is
    treated as a miss and re-resolved. ISRC keys are globally unique and skip the check.
  - **#14 (MEDIUM) non-deterministic ties.** `bestScored` now breaks score ties by
    lowest `(isrc, sourceId)` so re-runs pick the same candidate regardless of the order
    the platform returned them.
  - **#13 (MEDIUM) unmatched persisted, suppressing retries.** Per §12.5 self-healing, an
    unmatched track must retry on the next run (catalogs drift). `persist` now skips
    `unmatched` rows entirely; the unmatched event (with rejected candidate + score) is
    still emitted live for Phase 7's `operation_events`.
  - **#9 (MEDIUM) explicit flag false-positive.** `appleCatalogToCanonical` mapped
    `contentRating === "explicit"`, yielding `false` when the rating was simply absent —
    spuriously earning the +10 explicit-match bonus. Now maps absent → `undefined`.
  - **#8 (LOW) album disambiguation used normTitle** (which strips "(feat. …)"); switched
    to plain `normalize` for album comparison.
  - **#21 (MEDIUM) no fake-client injection.** Added `__setMatcherClients` /
    `__resetMatcherClients` seam so Tier-1/Tier-2 paths are unit-testable without live
    tokens.

- **Spotify API correctness (Tier B):**
  - **#5 (HIGH) `searchTracks` limit=25 but Spotify caps at 10.** Clamped to 10
    (`SPOTIFY_SEARCH_MAX_LIMIT`); matcher passes 10.
  - **#1/#23 (LOW) search-term operator injection.** A title like
    `Bad OR isrc:GBUM71029601` would hijack the `q=` query. Added `sanitizeSearchTerm`
    that strips Spotify field-operators (AND/OR/NOT/track:/artist:/isrc:/…) and quotes/
    colons before the search. Apple's `searchCatalog` strips quotes for defense in depth
    and clamps `limit` to 25.
  - **#6 (MEDIUM) — REJECTED after live test.** The verifier said to add
    `market=from_token` to Spotify search. Adding it returned `403 Insufficient client
    scope` live, because `from_token` requires the `user-read-private` scope we
    deliberately don't request (§5.1). A user-authorized token already scopes catalog
    availability to the user without an explicit market. Reverted the market addition;
    documented why inline. (The market concern applies to app-only tokens, which we
    don't use.) This is the sweep catching its own false positive — kept the limit clamp
    and sanitization, dropped the market change.

- **Identity robustness (Tier C):**
  - **#10 (LOW) normalize() used literal combining-diacritic chars** (fragile/invisible
    across editors). Switched to explicit `/[̀-ͯ]/g` escapes.
  - **#7/#25 (LOW/MEDIUM) VARIANT_TOKENS drift.** Implementation had 12 tokens vs the
    spec's 9 (added `remastered`, `acoustic`, `demo`). Rather than revert useful
    additions, **amended blueprint §7 + §15** to reflect them (the §0 governing principle
    grants heuristic evolution at the implementation tier; matching only gets stricter).

- **Test infrastructure (Tier D):**
  - **#17 (HIGH)** Tier-1 disambiguation: 11 new assertions (album match / non-comp /
    all-comp fallback / single / empty / all-invalid / validation predicate).
  - **#18 (MEDIUM)** symmetric `matchAppleToSpotify` now exercised via fakes.
  - **#20 (MEDIUM)** new `src/ledger/tracksCache.test.ts` (12 assertions) covering
    round-trip, the COALESCE cross-direction-id preservation invariant, overwrite of
    non-COALESCE fields, delete, and the sqlite-NULL-returns-null behavior that justifies
    the `nn()` coercion.
  - **#22 (MEDIUM)** `match.test.ts` now restores the ledger on SIGINT too, not just exit.
  - Matcher Tier-1/Tier-2 happy + fall-through + unmatched-not-cached + tie-break +
    fuzzy-collision-guard all unit-tested via injected fakes.

- **Documented / accepted lows (no code change, rationale recorded):**
  - **#3** search URLs logged at debug include the track title in `q=`. Track titles are
    NOT secrets (not in the §12 redaction list), and this is debug-level only. No action.
  - **#15** "parallel matcher ledger writes race." better-sqlite3 is synchronous and the
    upsert is a single atomic statement under WAL; within a Node turn there's no
    interleaving. Phase 7 runs one Operation at a time (§8). Accepted.
  - **#16** VARIANT_TOKENS "live"/"edit" can match a song genuinely titled with that
    word. The penalty only fires when the token is in the candidate but NOT the source
    (asymmetric), so a same-titled match is unaffected; this is inherent to the §7
    heuristic and per-spec. Accepted.

- Live AC #1 re-verified after all changes (ephemeral script): 1a explicit→Apple ISRC
  (Dust → 6769568594, explicit=true), 1b no-ISRC→Tier-2 (conf 100), 1c symmetric
  Apple→Spotify (Janice STFU → 514joG…), 1d cache hit (fromCache=true) — all PASS.
- **Total suite: 190/190 PASS** across 7 suites (log 39, spotify 21, apple 24, http 10,
  ledger 18, trackscache 12, match 66). Lint clean. Build clean.
- Phase 4 re-closed on a clean floor. Next: Phase 5 — Permissions preflight + gate.

### 2026-06-04 — Phase 5: Permissions preflight + gating

- Start: implement the 10-check preflight (env, Spotify ×4, Apple ×5) with the §11.1
  ordering (env-first, Spotify+Apple groups in parallel, intra-group skip-on-auth-fail),
  the §12 detail allow-lists, the gating policy (latest `passed` within 24h AND no
  `invalidated` since → gate open; else 412 on `POST /api/catalog/refresh` +
  `/api/operations`), refresh-aware auto-invalidation in `util/http.ts`, the
  `/api/preflight/*` endpoints + SSE, the `doctor` CLI sharing the same runner
  (`surface='cli'`), and the UI Permissions panel with the grouped live checklist +
  gate-state-driven button enable/disable. No pause points.

- Decisions:
  - `ledger/preflightStore.ts` holds all preflight_runs/checks queries + the gate
    computation. `computeGateState(nowMs)` is injectable for tests. Gate is OPEN iff a
    `passed` run's finished_at is within 24h AND no `invalidated` row was inserted after
    it — implemented as two indexed queries (latest passed, latest invalidated-after).
    `insertPreflightRun` maps the `one_running_preflight` partial-unique-index violation
    to a typed `PreflightRunningConflict` → route returns 409.
  - `preflight/checks.ts` holds the 10 leaf checks + the §12 detail allow-lists, enforced
    by `validateDetail` (throws on an extra key — a developer error caught in tests, never
    a silent leak). `spotify_me` hashes user.id to SHA256[0:12]; `apple_dev_token` reports
    alg/exp_days_remaining/signed but never iss/kid (= Team/Key ID). `apple_isrc_lookup`
    sources its fixture from the storefront top chart (§11.1) and self-skips if the chart
    has no ISRC. Failure details carry `error_message_safe` = redact(message).
  - `preflight/runner.ts` orchestrates env-first → Spotify+Apple groups via `Promise.all`
    → intra-group sequential with skip-on-gate-fail. seq is the fixed CHECKS position so
    rows stay ordered despite parallel execution. Emits per-check + terminal `complete`
    via an in-process EventEmitter registry for SSE. Final status: passed (0 fails) /
    partial (some pass, some fail) / failed (no pass). A guard `finally` guarantees no
    stranded `running` row.
  - `preflight/gate.ts` exposes `getGateState`, `invalidateGate`, the pure
    `classifyAuthFailure(status, body)`, and `installAuthFailureSink` which wires
    `util/http.ts`'s sink to the gate (keeps util/http ledger-free — the dependency edge
    points one way). util/http gained `reportAuthFailure` (opt-in) + `onUnauthorized`
    (reactive refresh): after a failed refresh-retry a persistent 401 → `auto-401`; a
    scope-403 (not rate-limit) → `auto-403-scope`; recovered 401s / 5xx never invalidate.
    The Spotify + Apple clients opt in (`AUTH_EXTRAS`) with a force-refresh /
    force-resign `onUnauthorized`.
  - HTTP: the router gained `:param` matching. `routes_preflight.ts` serves
    `/api/gate`, `/api/preflight/latest|run|:id|:id/events` (SSE with `id:`=seq +
    `Last-Event-ID` replay-from-ledger), and the gated stubs `POST /api/catalog/refresh`
    + `POST /api/operations` (412 when closed with the gate reason; 501 when open since
    Phase 6/7 own the bodies).
  - `cli.ts doctor` shares the runner (surface='cli'), waits for completion, then prints
    a grouped checklist in seq order (streaming was abandoned for the CLI because the
    parallel groups interleave; the UI groups by name so it's unaffected). Exit 0 only on
    pass.
  - Web: Permissions panel with Check permissions → POST run → EventSource over
    `/api/preflight/:id/events` → live grouped checklist; gate banner + Catalog/Run
    buttons enabled/disabled from `/api/gate`, polled on load, on focus, after a 412,
    and after the SSE stream ends (§11.1).
- Result: **all 6 Phase 5 AC verified.**
  1. ✅ live `doctor`: all 10 checks pass (env / spotify ×4 / apple ×5), gate → OPEN,
     gated POSTs return 501 (gate open, feature pending) not 412. SSE streams all 10
     check events + `complete`.
  2. ✅ live: dropped `user-library-modify` from tokens.json, ran preflight via the API
     → `spotify_scopes` fails with `missing_scopes=[user-library-modify]` + "Re-Connect
     Spotify to re-consent"; run status `partial`; gate stays closed.
  3. ✅ unit (`runner.test.ts`): missing `APPLE_TEAM_ID` → env fails → all 9 downstream
     `skip` with reason "prerequisite env failed"; final status `failed`.
  4. ✅ live: backdated the passed run's finished_at to 30h ago → `/api/gate` closed with
     "last pass was 26h ago (soft 24h expiry)"; `POST /api/catalog/refresh` → 412
     `{error:'gate_closed', reason:'…soft 24h expiry…'}`.
  5. ✅ unit (`gate.test.ts`, 17 assertions): classifier (401→auth, scope-403→scope,
     rate-limit-403→none, 429/500→none) + the util/http sink (persistent 401→auto-401,
     refresh-recovered 401→no invalidation, scope-403→auto-403-scope, rate-limit-403→none,
     opt-out request→none, 5xx→none).
  6. ✅ live: the `doctor` (surface='cli') pass is visible to `/api/gate` (open) and
     `/api/preflight/latest` (surface=cli, 10 checks); the UI's Check permissions writes
     an equivalent run — gate parity both directions. 409 returned when a second run
     starts while one is in flight.
- Tests added: `preflightStore.test.ts` (13), `gate.test.ts` (17), `runner.test.ts` (10).
  **Total suite: 230/230 PASS** across 10 suites. Lint + build clean. Ledger restored
  from a pre-test backup after the live AC#4 manual backdate; tokens untouched (6 scopes,
  Apple connected).
- Next: Phase 6 — Catalog cache + Operation form UI (the gated `POST /api/catalog/refresh`
  stub becomes the real incremental refresh; the 501 flips to 200/SSE).

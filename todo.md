<!-- @format -->

# v2 Build Plan — `music-transfer-self-serve` (ARCHIVED)

> **Status: ARCHIVED — historical planning artifact.** Phases **V0–V6 shipped** (YouTube Music is a
> deferred placeholder; see below). The unchecked boxes below are the _original_ plan as written
> before the build, kept for provenance — they do **not** reflect remaining work. The authoritative
> living docs are **`blueprint.md`** (architecture + §15 amendment log) and **`PROGRESS.md`** (dated
> build log, including the v2 phase entries and the full-audit cleanup). Don't treat this file as a
> live checklist.

---

## 0. Validation summary (2026-06-05)

The plan was validated three ways: a code walkthrough of the keystone files, a comparison
against the Figma mockups, and web research against official API docs.

### Code / engine claims — ALL CONFIRMED (no structural blockers)

The "keep the proven engine, refactor the surface" bet holds. Verified against real code:

- `operation/deps.ts` — `OperationDeps` (`src/operation/deps.ts:40-52`) is a clean,
  platform-**opaque** seam; the 5 `=== "spotify"` branches live only in the _implementations_.
  Rewriting onto a registry needs **no signature change** → `runner.ts` untouched.
- `operation/runner.ts` — the **only** platform coupling is `writeChunkSize` (~line 204). Moves
  into `capabilities.writeBatchAdd/Like`.
- `match/matcher.ts` — `matchSpotifyToApple` / `matchAppleToSpotify` (`:334`, `:400`) are
  near-identical; they collapse to one `matchToDestination(source, destProvider)`. The cache
  read/write (`:273`, `:322-323`) hardcode the 2-platform pair and **must become data-driven**
  (exactly what V2's `track_provider_ids` table does).
- `ledger/db.ts` — forward-only `MIGRATIONS` record + per-migration transaction supports
  migration #2 (new tables + `ALTER` + `INSERT…SELECT` backfill). `LATEST_SCHEMA_VERSION` = 1.
- `config.ts`, `auth/tokens.ts`, `http/server.ts` — all match the plan; Hono port is feasible
  (the one custom bit is the CSRF `<meta>` injection + EventEmitter→`streamSSE` adaptation).

### Stack — CONFIRMED

Hono `streamSSE` + `@hono/node-server` `serveStatic` are first-class; the Vite + `vite-plugin-solid`
dev-proxy → Hono, prod-static pattern is standard. (Gotchas: `serveStatic` root resolves from
`process.cwd()`; disable buffering/compression on SSE routes; Vite proxy is dev-only.)

### External APIs — THREE findings that change the plan (handle honestly per the truthfulness invariant)

1. **YouTube "Liked videos" is largely unavailable via the official Data API v3.**
   - _Reading_ liked videos: the LL/"Liked videos" playlist was made private at the data layer
     (~2024); `playlistItems.list` returns empty for the owner. The `favorites` relatedPlaylist is
     deprecated. ⇒ **YouTube-as-source-of-likes is not viable.**
   - _Writing_ a like: use **`videos.rate(rating=like)`** (50 units, scope `youtube.force-ssl`),
     **NOT `playlistItems.insert`**. The original V7 spec was wrong. Idempotency for likes must come
     from **our ledger** (we can't read LL back to dedupe).
   - Regular user playlists (`playlistItems.list/insert`) work normally — that path is fine.
2. **YouTube default quota is a hard bottleneck.** `search.list` ≈ ~100 matches/day;
   `playlistItems.insert` / `videos.rate` = 50 units each → ~200 writes/day. A few-hundred-track
   playlist takes days, or needs an audited quota-extension request (manual Google review, not
   guaranteed). **This is the single biggest practical risk in v2** — surface it in the UI, don't
   hide it.
3. **Spotify "one hosted instance for friends" caps at 5 users.** Development mode = **5
   authenticated users** (was 25), each added to the dashboard allowlist, and the **app owner must
   hold Spotify Premium** (2026 rule). Extended Quota Mode is **org-only + ≥250k MAU** → unreachable
   for a hobby instance. ⇒ the realistic model is **each person self-hosts their own copy with their
   own BYO dev app** (which is exactly the open-source/BYO-secrets direction), or one instance stays
   ≤5 allowlisted users. The "multi-user-ready" seam stays, but the README/DEPLOY must state this cap.

**Correction (in our favor):** Apple MusicKit JS has **no per-origin allowlist** — it is gated by the
signed developer-token JWT, so authorize() works from **any HTTPS origin**. v2 just needs TLS
(any valid cert) + the server minting/refreshing the dev-token JWT. (HTTPS-in-prod requirement
stands; `http://localhost` is allowed only for dev.)

**Net:** the architecture (provider abstraction, ledger migration, Hono+Solid surface, design system,
network deploy) is sound and unchanged. Only the **YouTube provider mechanics (V7)** and the
**multi-user/quota expectations** are revised below.

---

## 1. Why v2

v1 is complete (9 phases, 288 tests, additive Spotify↔Apple transfer with ISRC-first matching).
v2 takes it "to the next level" with three big changes:

1. **YouTube Music** as a third platform.
2. **Web-hostable** — migrate the surface to a lightweight full-stack TS framework and make it
   deployable beyond `127.0.0.1` (open-source, BYO-secrets, self-hosted privately by the owner).
3. **Vast UI overhaul** — a Figma-driven, component-based design system built entirely from
   swappable tokens, with light/dark/auto theming and full WCAG / keyboard / screen-reader support.

### Locked decisions

| Area              | Choice                                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server framework  | **Hono** + `@hono/node-server`                                                                                                                                                                                               |
| Client            | **Vite** + **Solid** (TypeScript strict)                                                                                                                                                                                     |
| Hosting model     | Open-source, **BYO-secrets**, **network-deployable** (not loopback-only). Owner self-hosts; we make it _doable_ (Docker + env + docs), we don't run the deploy.                                                              |
| Multi-user        | **Single-owner now, multi-user-READY** — explicit singleton `__owner__` user dimension in data model + security. No signup/login system yet.                                                                                 |
| Database          | **Keep SQLite** (`better-sqlite3`), persistent disk.                                                                                                                                                                         |
| YouTube           | **Deferred to final phase.** Official **YouTube Data API v3** (OAuth). No ISRC → title/artist Tier-2 only. **Likes via `videos.rate`, not playlist insert; liked set not readable; quota-bound (~100 matches/day).** See §0. |
| Client reactivity | **Solid** signals (revisitable for Preact at V4).                                                                                                                                                                            |

### Guiding principle

**Keep the proven engine; refactor the surface.** Do **not** rewrite `auth`, `clients`, `match`,
`operation/runner`, `ledger`, `preflight`, `util`. Generalize the ~30 `"spotify" | "apple"` branch
points into a provider abstraction, migrate the ledger forward, swap server + client, add the design
system, harden for deploy, add YouTube last.

---

## 2. Invariants & amendments

The five blueprint §0 invariants are **preserved** and re-confirmed every phase:

- **Non-destruction / additive-only** — no provider method, route, or UI control ever removes,
  unfavorites, or reorders. `supportsLikedRemoval` is the literal type `false`.
- **Secrets & privacy** — `util/log` redaction intact; tokens server-side; `.env`/`data/`/`secrets/`
  gitignored; the new session cookie carries no secret.
- **Truthfulness** — only official, verified endpoints; YouTube's no-ISRC degradation surfaced, not
  hidden; never invent a route.
- **Auditability** — every operation/preflight user-attributed in the ledger; SSE replay + event log
  preserved.
- **No autonomous scope creep** — multi-user is a _seam only_; pause points respected.

**Three §15 amendments required BEFORE building (human-attributed), all in Phase V0:**

- [ ] **A1 — Network-deployable.** §11.0 "127.0.0.1-only" is replaced by env-driven
      `BIND_HOST`/`ALLOWED_ORIGINS`/`ALLOWED_HOSTS` behind HTTPS. Show the replacement defenses are
      ≥ as strong (Origin+Host+CSRF preserved, secrets stay server-side, HTTPS added).
- [ ] **A2 — Multi-user-ready data seam.** §1 lists multi-user as out-of-scope; this adds only the
      _seam_ (`UserCtx`, singleton `__owner__`, user-keyed storage) — no signup/login. Confirms scope
      is not expanded operationally.
- [ ] **A3 — One signed session cookie.** §11.0 "no cookies" → "one signed, HttpOnly, Secure,
      SameSite=Strict session cookie carrying only `{userId}`; double-submit CSRF retained; no
      third-party cookies."

Later phases that need a §15 entry: **V2** (forward-only ledger migration, no data loss), **V6**
(env-config + cookie specifics), **V7** (third provider + ISRC-absence honesty note).

---

## 3. Target layout

```
music-transfer-self-serve/
├─ package.json                  # npm workspaces: ["server","web","packages/*"]
├─ Dockerfile, docker-compose.yml, DEPLOY.md          # NEW (V6)
├─ server/src/                   # was src/ — kept engine + Hono surface
│  ├─ server.ts, cli.ts, app.ts, config.ts (env-driven)
│  ├─ http/{middleware/*, routes.*.ts, sse.ts}        # Hono (replaces node:http server.ts/static.ts)
│  ├─ providers/{types,registry}.ts + {spotify,apple,youtube}/provider.ts   # NEW
│  ├─ clients/{spotify,apple}.ts                      # UNCHANGED
│  ├─ auth/{spotify,apple,tokens}.ts                  # tokens keyed {userId:{providerId}}
│  ├─ match/{identity,scoring,matcher}.ts             # matcher → direction-agnostic
│  ├─ operation/{types,deps,runner}.ts                # deps onto registry; runner UNCHANGED
│  ├─ catalog/catalog.ts, preflight/{checks,runner,gate}.ts   # loop the registry
│  └─ ledger/{db,tracksCache,catalogStore,operationsStore,preflightStore}.ts
├─ web/                          # NEW Vite + Solid app
│  └─ src/{main.tsx, App.tsx, api/, sections/, components/, theme/} + musickit.html
└─ packages/design-tokens/{tokens.ts, tokens.css}     # Figma tokens, single source of truth
```

**Dev:** `vite` (HMR) proxies `/api`+`/auth` to `tsx watch server/src/server.ts` → single browser
origin. **Prod:** `vite build` → Hono serves `web/dist` + API in one Node process, Dockerized,
behind the owner's reverse proxy/TLS.

**Deps to add (justify in PROGRESS.md):** `hono`, `@hono/node-server`; (dev) `vite`, `solid-js`,
`vite-plugin-solid`, `vitest` (web tests only — engine keeps its tsx-script tests). **Do not add:**
ORM, axios, CSS framework, client state library.

---

## 4. Phases

Long-lived branch **`v2`** off `main`. Each phase = one branch off `v2`, merged when AC passes
**and `cd server && npm test` (288) stays green**. One commit per phase, PROGRESS.md entry, secrets
audit before staging.

---

### Phase V0 — `v2/scaffold-amendments`

**Goal:** stand up the workspace and write the amendments without breaking the engine.

- [ ] Cut `v2` branch from `main`; cut `v2/scaffold-amendments` from `v2`.
- [ ] Root `package.json` with npm workspaces `["server","web","packages/*"]`.
- [ ] Move `src/` → `server/src/`; fix import paths only (no logic change). Move `src/*.test.ts`
      with it. Update `tsconfig.json`, scripts (`build`, `start`, `doctor`, `test`, `lint`).
- [ ] Scaffold `web/` Vite + Solid project (`index.html`, `vite.config.ts`, `tsconfig.json`,
      `src/main.tsx`, `src/App.tsx` placeholder).
- [ ] Scaffold `packages/design-tokens/` (empty `tokens.ts` + `tokens.css`).
- [ ] Write §15 amendments **A1, A2, A3** in `blueprint.md`.
- [ ] PROGRESS.md entries (start + end); justify new dev deps.

**AC:** `cd server && npm run build` green; **288 engine tests pass unchanged**; `cd web && vite
build` produces a shell; blueprint §15 contains A1–A3.

**Invariants:** all five re-stated; this phase only relocates + documents.

---

### Phase V1 — `v2/provider-abstraction`

**Goal:** replace the ~30 two-platform branches with `MusicProvider` + registry.

**Design decisions (resolved 2026-06-05 from reading `runner.ts`/`deps.ts`/`matcher.ts`):**

- **`deps.match` gains a 3rd arg `destination: ProviderId`.** Today `deps.match(source, useCache)`
  infers "destination = the opposite platform" — breaks for a 3rd provider. The runner has
  `spec.destination` in scope, so pass it (runner.ts lines ~123 and ~264). This keeps
  `runner.test.ts` green with **zero test edits**: old fakes `(source, useCache) => …` ignore an
  extra positional arg, and TS lets a 2-param fn satisfy a 3-param type. So "runner untouched"
  becomes "runner edits limited to: batch-size via capabilities + threading `destination` into
  `match`; all other logic byte-stable."
- **Matcher test seam changes.** `matchToDestination(source, destProvider)` calls
  `destProvider.searchByIsrc/searchByTerm`, so the old `__setMatcherClients` (fake client fns)
  seam is replaced by **registering fake providers**. `match.test.ts` must be migrated to the
  provider seam (it is NOT in the untouched set).
- **Cache stays on the v1 schema in V1.** `matchToDestination`'s cache read/write maps
  `destProvider.id → {spotify_id|apple_catalog_id}` columns (no-op for unknown providers). The
  generalized `track_provider_ids` table lands in **V2**, not here — keeps V1 schema-compatible.
- **Providers absorb platform quirks**: the Apple favorites→empty-D rule, library-vs-catalog
  destId, empty-playlist 40403, and the `toCanonical` adapters all move _into_ the provider
  modules; `deps.ts` becomes thin registry lookups.

- [x] `providers/types.ts` — `ProviderId`, `UserCtx`+`OWNER`, `ProviderCapabilities`
      (`supportsIsrc`, `supportsLikedRemoval: false`, `likedKind`, `likedReadable`,
      `canCreatePlaylist`, `playlistAppendOnly`, `writeBatchAdd/Like`, `searchLimit`), `DestTrack`,
      `MusicProvider` (operation+match surface; auth/catalog/preflight slices added in later phases).
- [x] `providers/registry.ts` — `registerProvider/getProvider/hasProvider/listProviders`
      (+ `__clearRegistry` test hook); tested in `providers/registry.test.ts` (11 asserts).
- [x] `providers/spotify/provider.ts` + `providers/apple/provider.ts` — wrap existing
      `clients/*`; `toCanonical` adapters moved in (return `CanonicalTrack[]`); own their quirks.
- [x] `match/identity.ts` — `CanonicalTrack.source` widened to `string` (ProviderId; avoids an
      import cycle).
- [x] `match/matcher.ts` — collapsed into `matchToDestination(source, destProvider, { useCache })`;
      Tier-1 gated on `supportsIsrc`; cache provider-keyed (v1 columns); + same-provider guard.
- [x] `operation/deps.ts` — rewritten onto `getProvider(...)`; `match()` gained a `destination` arg
      (can't infer "opposite platform" with >2 providers); `OperationDeps` otherwise stable.
- [x] `operation/runner.ts` — only the two `deps.match(…, spec.destination)` call sites changed
      (fakes ignore the extra arg → `runner.test.ts` literally untouched). **Batch-size-from-
      capabilities deferred to V7** (validation finding #1: writeChunkSize is byte-identical to v1,
      so deferring keeps parity; YouTube's `writeBatchAdd:1` will force it).
- [x] `operation/types.ts` — `Platform` widened to `string`. **`ledger/catalogStore.ts` /
      `catalog.ts` / routes `Platform` rename deferred** to the catalog/route phases (widening is
      non-breaking; not needed for the operation/match AC).
- [x] Register both providers at startup (`providers/index.ts` → `server.ts`).
- [x] **Tests added in validation:** `providers/registry.test.ts`, `operation/deps.test.ts`
      (registry-routing seam), `providers/providers.test.ts` (provider dispatch + capability
      invariants + `appleLibraryToCanonical`). Migrated `match/match.test.ts` to fake providers.

**AC:** ✅ Spotify→Apple ISRC match via `matchToDestination`; Apple→Spotify via the _same_ function;
`runner.ts`/`runner.test.ts` untouched & green; a `supportsIsrc:false` fake provider exercises
Tier-2-only with no engine edits. **tsc clean · 341 PASS / 0 FAIL · eslint clean.**

**Validation:** multi-persona workflow (`wf_0aa37892-805`, 5 personas + synthesis) → verdict
behavior-preserving + invariants intact, safe to merge. 6 findings, all low: #1 writeChunkSize
(deferred to V7), #2/#6 columnIdFor same-provider ambiguity + removed guard (fixed: defensive
`same_provider_match` guard in `matchToDestination`), #3 deps routing untested (fixed: `deps.test.ts`),
#4 provider wrappers untested (fixed: `providers.test.ts`), #5 `appleLibraryToCanonical` untested
(fixed). No spec move → no §15 row.

**Invariants:** additive-only (deps/writeTracks still only add); truthfulness; auditability. No §15.

---

### Phase V2 — `v2/ledger-migration`

**Goal:** generalize provider-id storage + add the user dimension, forward-only, zero data loss.

- [x] `ledger/db.ts` — migration #2 (`LATEST_SCHEMA_VERSION` 1→2):
  - [x] `CREATE TABLE users(...)`; seed `'__owner__'`.
  - [x] `CREATE TABLE track_provider_ids(identity_key, provider_id, provider_kind, provider_ref,
PRIMARY KEY(...), FK→tracks ON DELETE CASCADE)` + index.
  - [x] **Backfill** from `spotify_id`→(spotify,default) / `apple_catalog_id`→(apple,default) /
        `apple_library_id`→(apple,library); old columns left in place.
  - [x] `ALTER TABLE catalog|operations|preflight_runs ADD COLUMN user_id ... DEFAULT '__owner__'`.
        **Catalog PK rebuild DEFERRED** to multi-user activation (single owner can't collide).
  - [x] **Bonus fix:** latent `schema_version` singleton-row bug (PK is `version` → `INSERT OR
REPLACE` appended a row); `setVersion` deletes-then-inserts, `getCurrentVersion` uses `MAX`.
- [x] `ledger/tracksCache.ts` — generalized: identity row + `get/putProviderRef`; matcher
      `cacheHit`/`persist` use them. `deleteCachedTrack` cascades the refs.
- [ ] `auth/tokens.ts` reshape → **DEFERRED to V6** (lands with the session/user seam). Noted here.
- [x] §15 amendment added (schema extended, forward-only, INSERT/ALTER-ADD only, zero data loss).
- [x] **Test seams:** `__openLedgerAt(path)` + `__setLedgerInstance` so the migration test runs on a
      throwaway temp ledger (never touches the real one).

**AC:** ✅ a **real-shaped v1 `ledger.sqlite`** migrates to v2 with **zero row loss** (pre/post counts
asserted), correct backfill (incl. library kind), `user_id` defaulting, `schema_version=2` (single
row), and a **no-op on re-open**; a v1-cached match **resolves through the matcher** post-migration
(end-to-end backfill→cacheHit). Real ledger confirmed intact (~1,600 tracks, integrity ok).
**tsc + eslint clean · 373 PASS / 0 FAIL.**

**Validation:** 5-persona workflow (`wf_1a423645-581`) → migration zero-data-loss + safe, cache
parity-preserving. 8 findings (all verified): 1 HIGH was a test-harness corruption risk (`db.test.ts`
recreated the real ledger path) — **fixed** (temp-path migration test + sidecar-safe cleanup); the
other 7 (medium/low) coverage gaps all **resolved**.

**Invariants:** non-destruction (CREATE/INSERT/ALTER-ADD only — verified zero loss); auditability
strengthened (user attribution).

---

### Phase V3 — `v2/hono-server`

**Goal:** swap `node:http` → Hono, keeping routes wire-compatible (old UI = regression oracle).

- [x] `http/app.ts` `buildApp()` — Hono app: security middleware (Host all / Origin+CSRF POST) +
      `bodyLimit`→413 + JSON-hardening + health fixtures + route modules + static fallback + 404.
- [x] Security middleware ported verbatim (Host/Origin/CSRF; per-start CSRF `<meta>` injection).
      **Session/`UserCtx` middleware deferred to V6** (network/session phase, not needed single-owner).
- [x] `routes_{auth,preflight,catalog,operations}.ts` — same paths + shapes as §11.2, ported to Hono
      Context. **Registry-loop generalization of auth/catalog shapes deferred to V5** (new UI) — would
      break the old-UI oracle. `parseUrl`/`looksLikeBareId` unchanged (unit test intact).
- [x] `http/sse.ts` — shared streamSSE wrapper (serialized writer + terminal `done()` + abort cleanup)
      with `Last-Event-ID` replay; backs all three SSE streams.
- [x] Static via Hono (`serveStaticFile` → `Response`); CSRF `<meta>` injection preserved. (Serves
      `server/web` in V3; switches to `web/dist` in V5/V6.)
- [x] `server.test.ts` ported + **hardened** (ledger isolation + header/shape/413/SSE-idle coverage);
      `routes_operations.test.ts` unchanged (pure helpers).

**AC:** ✅ every §11.2 endpoint returns the v1 status/shape (verified live + in CI); 403 on bad
Host/Origin/CSRF, 404/413 shapes, SSE `Last-Event-ID:N` replays seq>N then closes on terminal; old
vanilla UI still drives it. **tsc + eslint clean · 386 PASS / 0 FAIL.**

**Validation:** 5-persona workflow (`wf_5a86d4c0-379`) → behavior-preserving + secure, no blockers.
5 findings: 1 MEDIUM (JSON responses lost `no-store`/`nosniff`/`charset` vs v1 `sendJson`) — **fixed**
(JSON-hardening middleware); LOW (SSE field-order — re-scoped claim to EventSource-equivalent; no CI
coverage — **added** route/header/413/SSE tests + ledger isolation; stricter bodyLimit — kept).

**Invariants:** secrets/privacy (`nosniff` restored; redaction intact); auditability (SSE replay).

---

### Phase V4 — `v2/design-system`

**Goal:** Figma tokens + Solid primitives + theming + a11y. No ad-hoc styling anywhere.

- [x] `packages/design-tokens/tokens.ts` — single source: Figma **light** palette verbatim;
      **derived dark** palette (measured WCAG-AA, not eyeballed); the Inter + JetBrains Mono **type
      scale** (12 roles); space/radius/shadow (Card 40×30, `shadow-1`). + a `contrastRatio` util.
- [x] `build.ts` generates `tokens.css` (`:root` light + `[data-theme=dark]` + `prefers-color-scheme`
      fallback for "auto" + focus-visible + reduced-motion + `.t-*` type classes). Single source →
      never hand-edit the CSS.
- [x] Self-hosted fonts via `@fontsource-variable/{inter,jetbrains-mono}` (no runtime CDN).
- [x] Solid primitives (`web/src/components`): `Card`, `Button` (tier-1 outline + tier-2 filled,
      rest/hover/disabled; tier-2 inverts in dark), `StatusPill` (success/warning/error/general),
      `StatusDot`, `PermissionRow` (icon+label+dot+Check), `Dropdown` (native select), `Collapsible`,
      `ThemeToggle`. All tokens-only (no hex — grep-checked).
- [x] `ThemeProvider`/`useTheme` — light/dark/**auto**(`prefers-color-scheme`), persisted to
      `localStorage`, drives `[data-theme]`.
- [x] A11y: keyboard nav (native controls), `:focus-visible` ring, ARIA (`aria-expanded`/
      `aria-pressed`/`aria-label`/`role=img`), `prefers-reduced-motion`. Verified live via Playwright.

**AC:** ✅ components render from tokens only (no ad-hoc hex); light/dark/auto switch + persist;
**WCAG AA verified for all 29 text/status/focus pairs in BOTH themes** (`contrast.test.ts`, in CI);
keyboard nav + focus-visible + ARIA + reduced-motion. Visual: screenshotted light + dark via
Playwright — matches Figma. **build:all + tsc clean · 417 PASS / 0 FAIL.**

**a11y refinement (logged):** the mockup's white pill text fails AA on the bright Figma colors
(2.2/1.5/3.6:1) → kept the fills, used dark pill text (7.8/11.5/4.9:1), AA in both themes.

**Validation:** 5-persona workflow (`wf_cfb7f849-d54`) → 1 BLOCKER (a `kebab()` regex bug made all 8
button CSS vars dead → buttons rendered unstyled but _looked_ like buttons in the screenshot) — **fixed**

- added `css.test.ts` (var-superset + no-drift guard). Resolved: HIGH PermissionRow color-only state
  (→ visible text), MED dot 3:1 ring + FOUC pre-paint script + generated-CSS verification, LOW disabled
  legibility / `readStored` / `rem` sizes. Re-screenshotted: buttons now genuinely filled both themes.

**Invariants:** none touched (pure UI); truthfulness — status pills reflect real engine state.

---

### Phase V5 — `v2/solid-ui`

**Goal:** rebuild the home from V4 components, wired to a typed API client. Delete vanilla JS.

- [x] `web/src/api/client.ts` — typed fetch (CSRF from `<meta>` or `/api/csrf`) + `openSSE` wrapper
      (named events, terminal-close, auto-reconnect) for the 3 streams. `web/src/store.ts` holds the
      cross-section state + SSE-driven actions.
- [x] `web/src/sections/` from `Figma_home.png`:
  - [x] **Header** (title) + **Intro** text.
  - [x] **Setup** — auth rows per provider (Connect/Reconnect + popup watch + status text) +
        Permissions check → preflight SSE → live checklist + gate banner.
  - [x] **Catalog** — per-provider collapsible listing playlists, each with a **Transfer** (pre-fills
        the form); per-provider **Refresh** (SSE progress).
  - [x] **Operation** — registry-driven provider+target dropdown pairs (auto-exclude same provider;
        Liked/Favorites pinned ★; Create-new input) + **Start**.
  - [x] **Status** — live operation SSE: stage, aggregate counters, log (capped 500), logline,
        summary. (Copy buttons deferred — low value.)
  - [x] **History** — past operations from the ledger (status pills + timestamps).
- [x] Disambiguation modal on 422 (candidate list; create-new for destination).
- [x] Provider list from `GET /api/providers` (registry-driven) → **YouTube auto-appears** in V7.
- [x] Retired the vanilla UI (`server/web/{index,app.js,app.css}` deleted; `musickit.html` →
      `web/public`, self-contained). Server: `WEB_DIR` → `web/dist`; Vite proxy rewrites Origin.

**AC:** ✅ verified live against the user's real data (40 playlists, both connected, open gate, 4
history rows); Transfer pre-fills + auto-excludes + Start enables on a valid form; gate-closed disables
Catalog/Start; 422 disambig modal wired; **no vanilla DOM left**. The live Spotify→Apple write was NOT
triggered (writes to the user's real account — theirs to run; engine transfer+SSE proven by Phase 7 +
the V3 live-SSE smoke). `build:all` + tsc + eslint clean, **420 PASS / 0 FAIL**.

**Validation:** 5-persona workflow (`wf_76c785e9-788`) → core flow + API/SSE contract + additive-only/
security clean. Fixed: HIGH modal a11y (focus trap/Escape/return/backdrop), MED dangling form labels
(→ group + aria-labels), regression reconnect-on-reload (`resumeRunningOperation`), LOW 412 gate
re-poll + mid-run-drop toast.

**Invariants:** additive-only (UI calls only additive endpoints; no remove/unfavorite controls);
auditability (History reads the ledger).

---

### Phase V6 — `v2/network-deploy`

**Goal:** make it deployable over a network. Owner does the real deploy; we prove it's doable.

- [ ] `config.ts` — env-driven: `BIND_HOST` (default `127.0.0.1`), `PORT`, `PUBLIC_ORIGIN`,
      `ALLOWED_ORIGINS` (CSV), `ALLOWED_HOSTS` (CSV), `INSTANCE_ACCESS_TOKEN`. Per-provider config
      moves into provider modules. `SPOTIFY_REDIRECT_URI` derived from `PUBLIC_ORIGIN`.
- [ ] Session seam: submit `INSTANCE_ACCESS_TOKEN` once → set signed
      `HttpOnly/Secure/SameSite=Strict` cookie `{ userId: "__owner__", iat }`; middleware resolves
      `UserCtx` from it.
- [ ] `Dockerfile` (multi-stage: build web + server → run one Node process serving `web/dist` + API).
- [ ] `docker-compose.yml` (volume for `data/`; env file for secrets).
- [ ] `DEPLOY.md` — reverse proxy + HTTPS; **Spotify**: register the public HTTPS redirect URI +
      note production/extended-quota requirement; **Apple MusicKit requires HTTPS** off localhost;
      `data/` persistence; backup-before-upgrade note.
- [ ] §15 amendment: finalized env-config + session-cookie specifics.
- [ ] `.env.example` updated with the new keys (blank/fake values only).

**AC:** default env still binds loopback and behaves like v1 (no regression); with `PUBLIC_ORIGIN`/
`ALLOWED_ORIGINS` set, a cross-origin POST without matching Origin → 403, with it → 200; the 180-day
Apple JWT / `.p8` appear in **no** browser-facing response or log (grep test extends `log.test.ts`);
Docker image boots and serves UI + API on one port; cookie is HttpOnly+Secure+SameSite=Strict; bad/
missing access token gates the UI.

**Invariants:** secrets/privacy (defenses replaced 1:1 + HTTPS + cookie is secretless); additive-only
and truthfulness untouched.

---

### Phase V7 — `v2/youtube-provider` (FINAL)

**Goal:** add YouTube Music as a drop-in provider via the official API. No abstraction changes.
**Constraints validated in §0 — design to them exactly (truthfulness invariant):** no ISRC; Liked
videos **not readable** and liked via **`videos.rate`** (not playlist insert); strict default quota.

- [ ] Verify YouTube Data API v3 routes + current quota against live docs before wiring (truthfulness).
- [ ] `auth/youtube.ts` + provider `beginConnect/completeConnect` — OAuth (scope
      `youtube.force-ssl`), redirect `${PUBLIC_ORIGIN}/auth/youtube/callback`, same `state` store
      pattern as Spotify.
- [ ] `providers/youtube/provider.ts`:
  - [ ] Read: `playlists.list` (user playlists), `playlistItems.list` (playlist tracks),
        `search.list` (Tier-2 matching). **`listLikedOrFavorites` throws / returns unsupported** —
        LL is not enumerable.
  - [ ] Write: `addToPlaylist` → `playlistItems.insert`; `addToLikedOrFavorites` → **`videos.rate`
        (rating=like)**. Both 50 units / item.
  - [ ] Capabilities: `supportsIsrc:false`, `playlistAppendOnly:true`, `writeBatchAdd:1`,
        `likedKind:"liked"`, **`likedReadable:false`** (⇒ liked-destination uses empty-D +
        ledger-based idempotency, the same pattern as Apple favorites in `deps.ts`).
- [ ] YouTube `preflightChecks()` slice (auth, search read, playlist read, **quota headroom note**).
- [ ] **Quota guard:** estimate `search.list` + write units for an operation up front; if it would
      exceed remaining daily quota, warn before starting and degrade gracefully (the §12.5
      "failed item is logged, never fatal" rule already covers per-track quota-exhaustion 403s).
- [ ] `config.ts` + `.env.example` — YouTube OAuth client env keys.
- [ ] Honesty UI: when YouTube is source or destination, show "no ISRC — title/artist matching only
      (lower confidence)" **and** "YouTube API quota limits large transfers (~100 matches/day)".
- [ ] §15 amendment: third provider + ISRC-absence + liked-not-readable + quota notes.

**AC:** YouTube appears in provider dropdowns with **no UI change**; a Spotify→YouTube transfer adds
videos via search-match, recorded `tier:"search"` / lower confidence in the event log and ledger;
**no Tier-1 / `searchByIsrc` path is attempted** for a YouTube destination (asserted); a
liked-destination uses `videos.rate` and stays idempotent via the ledger; quota-exhaustion 403s are
logged as `failed` (non-fatal), not crashes; additive-only (no delete/unlike path); both honesty
notices render.

**Invariants:** truthfulness (degradation + quota surfaced; official API only — no scraping; no
LL-read invented); non-destruction (additive); auditability (tier recorded).

---

## 5. Risks & guards

| Risk                                                                                                       | Owner phase | Guard                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ledger migration data loss (irreversible, single-user)                                                     | V2          | Forward-only INSERT backfill; assert pre/post row counts on a copy of a **real** v1 db; keep v1 columns; back up before run.                                                                           |
| Breaking the 288-test suite during surface swap                                                            | V1, V3      | V1 keeps `OperationDeps`/`runner.ts` shapes; V3 keeps endpoint shapes → tests port mechanically. Green tests = merge gate.                                                                             |
| **Spotify dev-mode caps (validated §0): 5 users + owner-Premium; Extended Quota unreachable**              | V6          | One instance ≤5 allowlisted users; `DEPLOY.md`/README state the cap + Premium requirement + the "self-host your own copy with your own BYO app" model. Not a code blocker — it's an honesty/docs item. |
| Apple MusicKit JS HTTPS off localhost (validated §0: **no** per-origin allowlist — JWT-gated)              | V6          | `DEPLOY.md` mandates HTTPS public origin; `musickit.html` served from `PUBLIC_ORIGIN`; server mints/refreshes the dev-token JWT; nonce flow unchanged; no invented workaround.                         |
| YouTube has no ISRC → silent low-quality matches                                                           | V7          | `supportsIsrc:false` forces Tier-2; UI surfaces degradation; ledger records `tier:"search"`.                                                                                                           |
| **YouTube quota ≈100 matches/day + 200 writes/day (validated §0) — the biggest practical v2 risk**         | V7          | Pre-flight quota estimate + warning; per-track 403 logged as `failed` (non-fatal, §12.5); UI states the limit; document the quota-extension request path. Don't promise large transfers.               |
| **YouTube liked set not readable (LL private)**                                                            | V7          | `likedReadable:false` → empty-D + ledger idempotency (Apple-favorites pattern); like via `videos.rate`; never invent an LL-read.                                                                       |
| Network exposure weakens loopback's implicit security                                                      | V6          | 1:1 Host/Origin/CSRF replacement + session cookie + HTTPS; grep test that JWT/`.p8`/tokens never reach browser or logs.                                                                                |
| Session cookie ↔ CSRF interaction                                                                          | V6          | Keep double-submit CSRF **and** `SameSite=Strict`; cookie carries only `userId`, signed.                                                                                                               |
| "Multi-user-ready" scope creep                                                                             | V0/V2       | Build only the seam (`UserCtx`, `__owner__`, keyed storage). No signup/login UI. Human-attributed §15.                                                                                                 |
| Provider abstraction leaks platform quirks (Apple 40403 empty-playlist, append-only, eventual consistency) | V1          | Quirks stay inside each provider module; capabilities express them to the engine; resume-soundness union unchanged.                                                                                    |
| Dark palette fails WCAG AA                                                                                 | V4          | Derive against measured contrast ratios; AA check is an explicit AC; re-tune status colors.                                                                                                            |

---

## 6. Verification

- **Every phase:** `cd server && npm test` (288 green — hard merge gate); `npm run build` + `npm run
lint` clean; secrets audit before staging (gitignored paths untracked; grep staged diff for
  `BEGIN PRIVATE KEY`, Team/Key IDs, bearer strings).
- **V1:** fake `supportsIsrc:false` provider exercises Tier-2-only with no engine edits; match +
  runner tests unchanged.
- **V2:** migrate a copy of a real `ledger.sqlite`; assert pre/post row counts equal; v1-cached match
  still resolves; idempotency test passes on migrated cache.
- **V3:** curl each §11.2 endpoint, diff status/shape vs v1; SSE `Last-Event-ID` replay.
- **V4:** automated AA contrast over every token text/status pair (light + dark); VoiceOver smoke +
  keyboard tab-through on each primitive; grep components for stray hex.
- **V5:** supervised live Spotify→Apple transfer in the new UI; idempotent re-run writes zero.
- **V6:** boot loopback env (no regression) then fake public origin; Origin/CSRF 403/200 matrix; grep
  browser responses + logs for JWT/`.p8`/tokens; `docker compose up` serves UI+API on one port.
- **V7:** supervised Spotify→YouTube transfer; assert no `searchByIsrc` for YT dest; events
  `tier:"search"`; no removal path.

---

## 7. Open / revisitable

- [ ] **Solid vs Preact** — defaulting to Solid; revisit at V4 if Preact is preferred.
- [ ] **Access control** — `INSTANCE_ACCESS_TOKEN` + cookie is the minimal seam; could move to proxy
      basic-auth. Real per-user accounts are explicitly out of v2 scope. **Validated cap (§0):** even
      with the multi-user seam, a single Spotify dev app serves ≤5 allowlisted users + owner-Premium,
      so the realistic distribution model is per-user self-hosting (BYO dev app) — reflect in README.
- [ ] **Drop v1 id columns** — optional later migration #3 once `track_provider_ids` is proven.

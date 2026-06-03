<!-- @format -->

# Blueprint — `music-transfer-self-serve`

A personal, self-hosted **local web tool** for running one-time **transfer operations**
between Spotify and Apple Music, with intelligent recording-level matching (ISRC-first)
so that the _correct version_ of each track is transferred — not a remix, not the clean
edit when an explicit master exists, not a re-release.

This document is the **source of truth** for an autonomous coding agent (Claude Code).
It is written to be executed near-hands-off.
The only times the agent should stop and hand control back to the human are clearly
marked **`⏸ PAUSE POINT`** blocks (all of which are credential/sign-in steps).
Everything else the agent builds, verifies, and commits on its own.

Operating rules for _how_ the agent should work live in `CLAUDE.md`.
This file describes _what_ to build and _why_. Read both before starting.

---

## 0. Governing principle — a living, self-healing blueprint

This project is **not** a fixed contract to implement once and freeze.
It is a **living system** that must keep working as platform APIs, the owner's needs,
and your own understanding change.
Treat both this blueprint and `CLAUDE.md` as documents you are _expected to amend_ as you
learn.
Rigid, frozen requirements would guarantee failure the moment Apple or Spotify shifts
an endpoint.

Two tiers govern every decision.
Knowing which tier a thing belongs to is the whole game.

**Invariants — never weaken these.**
They are the reason the tool is trustworthy.
You may _add_ to them; you may never edit, soften, or route around them.

1. **Non-destruction.** Additive-union by default.
   No deletion of user data without explicit per-run opt-in, a passed capability probe where
   the platform needs one, and a confirmation pause.
2. **Secrets & privacy.**
   Never commit or print secrets or personal data; always redact;
   Spotify stays secret-less (PKCE).
3. **Truthfulness.** Never invent an API endpoint or capability.
   Verify the volatile parts against live behavior/docs;
   when unverifiable, degrade to report-only and say so.
4. **Auditability.** Every run resumable; every decision recorded in the ledger.
5. **No autonomous scope creep.** Don't expand beyond §1 scope on your own.
   The human may amend scope; you don't grow it unilaterally.

**Implementation — evolve this freely.**
Everything else is a _current best guess, not a mandate_: the tech stack, schema, phase
ordering, matching heuristics and thresholds, endpoint routes, file layout.
When you find a better or more correct approach, **change it** — then log it (§15) and
keep the rest of the document consistent with the change.

**Self-healing is a runtime requirement too**, not just a build-time stance — see §12.5.
The finished tool must detect drift (changed endpoints, regressed capabilities, expired
tokens, stale matches) and recover or degrade gracefully rather than corrupt state or fail
silently.

**Change protocol — follow this whenever you amend the spec:**

- Make the smallest change that solves the problem; preserve every invariant.
- Update _all_ affected sections so the document stays internally consistent
  (no stale schema or endpoint left elsewhere).
- Append a dated entry to the Amendment log (§15): what changed, why, and which invariants
  you confirmed remain intact.
- If a change would weaken an invariant or expand scope, **do not** —
  stop and ask the human.

---

## 1. North star & scope

**Goal:** Provide a small, self-hosted **web UI** for running one-time
**transfer Operations** between Spotify and Apple Music — safely (never destroys data),
additively (only adds missing tracks to the destination),
idempotently (re-running an unchanged operation writes nothing),
and intelligently (recording-level matching so the _correct version_ of each track lands
on the destination).

**The Operation is the unit of work.** Each Operation is parameterized by:

- `source` — `spotify` | `apple`
- `destination` — `spotify` | `apple` (must differ from `source`)
- `sourceTarget` — either a playlist on the source side (id / URL / name),
  **or** the source's "Liked Songs" (Spotify) / "Favorite Songs" (Apple) collection
- `destinationTarget` — same shape on the destination side.
  The UI disables the free-text playlist input whenever "Liked"/"Favorites" is selected
  on that side.

When the human presses **Run**, the tool resolves the source set, matches each track on
the destination side, writes the missing items, and streams live status (per-track
progress, matches, skips, unmatched, errors) back into the UI.
A durable local ledger records every Operation for audit and caches resolved matches so
re-runs are fast and idempotent.

**In scope**

- A local web UI (HTML/CSS/JS, no framework) served by a small embedded Node HTTP server.
- A **Permissions preflight** that exercises every credential, scope, and read capability
  the tool relies on (env, both tokens, Spotify scopes, storefront, sample reads on each
  side, ISRC lookup) and **gates Catalog refresh and Operation runs** behind a recent
  passing result. The same orchestrator backs the CLI `doctor` command.
- One-time additive transfer Operations between any combination of `{spotify, apple}`
  source and destination, with each target being either a playlist (id/URL/name) or
  Liked/Favorites.
- An on-demand **Catalog** cache: after preflight passes, the human clicks
  "Update Catalog" and the tool fetches and caches the user's playlists on each connected
  platform, so the Operation form can offer a dropdown picker instead of asking for ids.
- Intelligent matching: same recording on both sides via ISRC, with a scored search
  fallback.
- Live operation status in the UI; a durable local ledger that makes operations resumable
  and re-runs idempotent.
- Publishable to a public GitHub repo with **zero** secrets or personal data tracked.

**Explicitly out of scope** (do not build):
multi-user support, a hosted/remote service, distribution or packaging for others,
continuous or scheduled syncing (operations are run on-demand from the UI),
bidirectional reconciliation, removal propagation, and any account-creation or payment
flows.
The original bidirectional-sync-with-baseline design is deliberately deferred — see
Amendment log §15 (2026-06-03).
If it returns, it will re-introduce the §6 capability gates and confirmation pauses.

**Non-negotiable safety posture:** additive only.
An Operation _adds_ missing tracks to the chosen destination collection.
It never removes tracks from either side, never reorders, and never touches anything
outside the chosen `destinationTarget`.
When the destination is a playlist named in free-text that does not yet exist on the
destination side, the tool may create it (and only it) —
never anything else.

---

## 2. Tech stack (decided — do not substitute without recording a reason in `PROGRESS.md`)

| Concern             | Choice                         | Rationale                                              |
| ------------------- | ------------------------------ | ------------------------------------------------------ |
| Language/runtime    | TypeScript on Node.js ≥ 20     | Native `fetch`, stable, matches owner's stack          |
| Execution           | `tsx` for dev, `tsc` for build | No bundler needed for a local CLI                      |
| HTTP                | Built-in `fetch`               | Avoid an axios dependency; wrap it for retry/backoff   |
| Persistence         | `better-sqlite3`               | Synchronous, fast, zero external service, single-file  |
| JWT signing (Apple) | `jsonwebtoken`                 | ES256 developer-token signing from `.p8`               |
| Env loading         | `dotenv`                       | Local secrets via `.env`                               |
| Local auth server   | Node built-in `http`           | Captures OAuth redirect + Apple MUT; no Express needed |
| Lint/format         | ESLint + Prettier              | Standard hygiene                                       |

Keep the dependency tree minimal. Prefer the standard library.
Every added dependency must be justified in `PROGRESS.md`.

---

## 3. Repository layout (target)

```
music-transfer-self-serve/
├─ blueprint.md                 # this file (tracked)
├─ CLAUDE.md                    # agent operating manual (tracked)
├─ README.md                    # human setup + usage (tracked)
├─ PROGRESS.md                  # agent's running build log (tracked)
├─ package.json / tsconfig.json # (tracked)
├─ .gitignore                   # (tracked)
├─ .env.example                 # template, no real values (tracked)
├─ src/
│  ├─ server.ts                 # entrypoint: starts the HTTP server, opens the UI
│  ├─ cli.ts                    # minimal CLI: `doctor` only (health/diagnostics)
│  ├─ config.ts                 # load + validate env
│  ├─ auth/
│  │  ├─ spotify.ts             # Authorization Code + PKCE, token refresh
│  │  └─ apple.ts               # dev-token JWT + Music-User-Token capture
│  ├─ clients/
│  │  ├─ spotify.ts             # read + write wrapper
│  │  └─ apple.ts               # read + write wrapper + capability probing
│  ├─ catalog/
│  │  └─ catalog.ts             # fetch + cache the user's playlists per platform
│  ├─ preflight/
│  │  ├─ checks.ts              # individual check fns (env, tokens, sample reads, probes)
│  │  └─ runner.ts              # orchestrates all checks, emits SSE events; shared by UI + CLI
│  ├─ match/
│  │  ├─ identity.ts            # ISRC normalization + fuzzy fallback key
│  │  ├─ scoring.ts             # candidate scoring for the search fallback
│  │  └─ matcher.ts             # tiered matching, both directions
│  ├─ operation/
│  │  ├─ types.ts               # Operation, Source, Destination, Target, Event types
│  │  └─ runner.ts              # orchestrates a single Operation, emits status events
│  ├─ ledger/
│  │  └─ db.ts                  # schema + queries + forward migrations
│  ├─ http/
│  │  ├─ server.ts              # routes: /api/auth/*, /api/catalog, /api/operations, SSE
│  │  └─ static.ts              # serves /web/
│  └─ util/
│     ├─ http.ts                # fetch with backoff, 429/Retry-After handling
│     └─ log.ts                 # structured logging that NEVER prints secrets
├─ web/                         # tracked: static assets served by src/http/server.ts
│  ├─ index.html                # auth status + catalog + operation form + run panel
│  ├─ app.css
│  ├─ app.js                    # vanilla JS, no framework / no bundler
│  └─ musickit.html             # the MUT-capture page loaded during Apple auth
├─ data/                        # GITIGNORED: sync.sqlite, tokens.json
└─ secrets/                     # GITIGNORED: AuthKey_*.p8
```

---

## 4. Secrets & GitHub hygiene (must be correct from Phase 0)

This repo goes public.
Treat everything that identifies the owner or grants account access as radioactive.

**Never tracked (must be in `.gitignore` before the first commit):**

```
node_modules/
dist/
.env
*.p8
secrets/
data/
tokens.json
*.sqlite
*.sqlite-journal
.DS_Store
```

**Tracked, but templated only (no real values):** `.env.example`.

**Secrets live in `.env`** (gitignored).
The Apple private key file lives in `secrets/` (gitignored).
Tokens captured at runtime (Spotify refresh token, Apple MUT) are written to
`data/tokens.json` (gitignored), **never** to `.env.example`, logs, commits, or chat.

`.env.example` keys (values blank or obviously fake):

```
SPOTIFY_CLIENT_ID=
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
APPLE_TEAM_ID=
APPLE_KEY_ID=
APPLE_PRIVATE_KEY_PATH=secrets/AuthKey_XXXXXXXXXX.p8
APPLE_MUSICKIT_APP_NAME=spotify-to-apple-music
```

Note: Spotify uses PKCE, so there is **no client secret** to store — good.
Do not introduce one.

Before any commit, run a secrets audit (see `CLAUDE.md` §git workflow).
At minimum: confirm `git status` shows none of the gitignored paths, and grep the staged
diff for the values of `APPLE_TEAM_ID`, `APPLE_KEY_ID`, any `BEGIN PRIVATE KEY`, and any
captured token.

---

## 5. Authentication design

### 5.1 Spotify — Authorization Code with PKCE

- Scopes (read **and** write, since Operations may write to either side):
  `playlist-read-private playlist-read-collaborative user-library-read`
  `playlist-modify-private playlist-modify-public user-library-modify`
- Flow: generate code verifier/challenge → open browser to `/authorize` → user approves
  → Spotify redirects to the loopback `SPOTIFY_REDIRECT_URI` → local `http` server captures
  the `code` → exchange for access + refresh tokens →
  persist the refresh token (and the granted `scope` string) to `data/tokens.json`.
- Refresh tokens automatically on 401 / expiry.
  Never require re-consent unless the refresh token is revoked.

> **⏸ PAUSE POINT A — Spotify app registration.**
> The agent cannot create the Spotify app.
> When reaching Phase 2, stop and instruct the human:
> create an app at the Spotify Developer Dashboard, copy the **Client ID** into `.env`
> as `SPOTIFY_CLIENT_ID`, and add the redirect URI
> `http://127.0.0.1:8888/auth/spotify/callback` to the app's settings.
> Then resume.

> **⏸ PAUSE POINT B — Spotify consent.**
> The human clicks **Connect Spotify** in the UI's Auth panel; the agent opens the popup
> and serves the callback.
> The human logs in and approves. Token capture is automatic; resume.

### 5.2 Apple Music — developer token + Music-User-Token

Two distinct tokens are required for any library write:

1. **Developer token** — a JWT the tool signs itself with the `.p8` key, proving app
   identity.
   - Sign with **ES256**, `iss` = Team ID, `kid` = Key ID, max lifetime 6 months.
     Regenerate automatically when it is within ~7 days of expiry.
   - Reference contract:
     ```ts
     jwt.sign({}, privateKeyPem, {
       algorithm: "ES256",
       expiresIn: "180d",
       issuer: APPLE_TEAM_ID,
       header: { alg: "ES256", kid: APPLE_KEY_ID },
     });
     ```
2. **Music-User-Token (MUT)** — proves the human authorized this app to touch their
   library.
   Obtained via MusicKit JS in a browser: the agent serves a tiny local static page that
   loads MusicKit JS v3, configures it with the developer token, calls `authorize()`,
   and POSTs the returned MUT back to the local server, which persists it to
   `data/tokens.json`.

Every Apple write call sends both: `Authorization: Bearer <devToken>`
**and** `Music-User-Token: <mut>`.

Always resolve the storefront dynamically from `GET /v1/me/storefront` —
**never hardcode `us`**.
ISRC availability is per-storefront and the owner's storefront may differ.

> **⏸ PAUSE POINT C — Apple Developer setup.**
> The human has an Apple Developer membership.
> When reaching Phase 3, stop and instruct:
> in Certificates, Identifiers & Profiles, register a Media Identifier and create a
> **MusicKit** private key;
> download the `.p8` into `secrets/`;
> put the **Team ID** and **Key ID** into `.env`.
> Then resume.

> **⏸ PAUSE POINT D — Apple authorization.**
> The human clicks **Connect Apple Music** in the UI's Auth panel;
> the agent serves the local MusicKit page in the popup.
> The human clicks Authorize and approves Apple Music access.
> MUT capture is automatic; resume.

---

## 6. API reality notes (verified at authoring — the agent MUST re-verify via `doctor`)

These constraints shape the whole transfer model.
They are also the parts of the platform APIs most likely to drift, so the agent treats them
as a strong prior and confirms each at build time with a live capability probe rather than
trusting this document blindly.

1. **Apple playlist writes are append-only.**
   The API adds tracks to the _end_ of an editable library playlist;
   there is no insert-at-position and no reorder.
   Add in source order, in sequential (not concurrent) batches.
2. **Apple playlist track _removal_ via REST is unreliable/unsupported.**
   Apple's developer relations have repeatedly stated the API supports only _adding_ to
   the cloud library and editable playlists.
   Some clients report removal working only for playlists created through MusicKit's
   native `createPlaylist`, and not for playlists created via the REST API;
   others with `canEdit=true` find no working REST delete.
   **Therefore: Apple-side removals are report-only by default.**
   The original design called for a runtime probe (create a throwaway test playlist,
   add a track, attempt removal, observe, then clean up) to gate any removal feature
   behind.
   **v1 deletes nothing**, so the probe is **deferred** — it is not implemented and not
   run as part of the §11 preflight (see Amendment log 2026-06-03).
   If removal propagation ever returns via amendment, the probe returns with it:
   implement it then, run it in preflight and at relevant capability boundaries,
   and gate any removal code path on its pass.
3. **Apple Favorites are one-way from third parties.**
   A song can be favorited via the API, but it **cannot be un-favorited** by a third-party
   app — only inside the Apple Music app itself.
   So Liked⇆Favorites removals on the Apple side are always report-only.
   Also: the exact REST route for _favoriting a song_ has shifted (a dedicated favorites
   capability now exists alongside the older `PUT /v1/me/ratings/songs/{id}` with value
   `1`).
   The agent must verify the current correct endpoint against live Apple documentation
   before wiring it, and must not invent a route.
4. **ISRC lookup can return multiple results and dead entries.**
   `filter[isrc]` may return several songs (same recording across single/album/deluxe),
   and some results 404 when fetched.
   Never blindly take `data[0]`; disambiguate (see §7) and validate the chosen candidate.
5. **Spotify is the more capable side.**
   Spotify supports reading, adding, **and removing** tracks from playlists and saved
   tracks.
   So removals _can_ be applied on the Spotify side (still opt-in and confirmed,
   because they are destructive).

Net effect on direction symmetry:

| Operation                  | Spotify side          | Apple side                         |
| -------------------------- | --------------------- | ---------------------------------- |
| Add track to playlist      | ✅ supported          | ✅ supported (append-only)         |
| Remove track from playlist | ✅ supported (opt-in) | ⚠️ report-only unless probe passes |
| Save / Like a track        | ✅ supported          | ✅ supported (favorite)            |
| Unsave / Unfavorite        | ✅ supported (opt-in) | ❌ report-only (API can't)         |
| Reorder                    | ✅ supported          | ❌ not supported                   |

The tool therefore guarantees **additive convergence per Operation** in whichever
direction the human chose.
In v1 there are no removal code paths at all (see §6.2 and the 2026-06-03 amendment);
if removals ever return, behavior on removals will be **best-effort, opt-in, and
capability-gated**, with the asymmetries above re-stated honestly in the README.

---

## 7. Matching engine (recording-level, both directions)

Identity is anchored on **ISRC** — a globally unique code for a _specific recording_.
Distinct recordings (remix, edit, live, remaster, clean vs. explicit) carry distinct
ISRCs, so matching on ISRC inherently selects the correct version.
Spotify exposes it at `track.external_ids.isrc`;
Apple exposes it at `attributes.isrc` and accepts it via `filter[isrc]`.
Spotify search also accepts `q=isrc:<code>`, so the engine is symmetric.

**Tier 1 — ISRC exact.**

- Spotify→Apple: `GET /v1/catalog/{storefront}/songs?filter[isrc]=<isrc>`
  (batch up to 25 ISRCs).
- Apple→Spotify: `GET /v1/search?q=isrc:<isrc>&type=track`.
- Disambiguate multiple results deterministically:
  prefer the candidate whose album matches the source album →
  then a non-compilation / non-"Greatest Hits" album →
  then the first _validated_ (non-404, fully-attributed) candidate.
  Selection must be stable across re-runs.

**Tier 2 — scored search fallback** (when no ISRC, or ISRC yields nothing valid):

- Query by `term = "<title> <primary artist>"`, take top N, score each:

  ```
  +40  normalized title exact match
  +30  primary-artist overlap
  +15  duration within ±3s (Spotify duration_ms vs Apple durationInMillis)
  +10  explicit flag matches (Spotify track.explicit  ==  Apple contentRating=="explicit")
  +5   normalized album match
  -25  per unwanted variant token present in candidate but NOT in source
       (remix, live, sped up, slowed, remaster, instrumental, edit, karaoke, cover)
  ```

- Accept the top candidate only if score ≥ **70**.
  Below threshold → **unmatched**, never a guess.
  The explicit-flag rule and the variant penalty are what preserve "correct version"
  once the ISRC guarantee is gone.

**Tier 3 — unmatched.**
Emit an `unmatched` event to the Operation's SSE stream with source metadata, both-platform
deep links, and the best rejected candidate + its score, and persist the same payload to
`operation_events`.
The human can review and resolve the long tail from the Run panel.

Every resolved mapping (source ID ⇆ ISRC ⇆ target ID, tier, confidence) is cached in the
ledger so future runs skip re-matching.

---

## 8. Operation engine — additive one-way transfer

An Operation is a single forward pass:
read the source set, match each track on the destination side, and add the missing ones
to the destination collection.
There is no baseline, no reconciliation, no removal —
an Operation only ever _grows_ the destination set.

**Identity key** for set membership: ISRC when present;
otherwise a normalized `title|artist|durationBucket` fuzzy key flagged low-confidence.

**Per Operation:**

1. **Resolve `sourceTarget`** to a concrete collection on the source platform —
   a playlist (by id, or by URL parsed to id, or by name resolved against the catalog
   cache), or the source's Liked/Favorites.
   Read its full track set `S`, capturing ISRC + metadata for each item.
2. **Resolve `destinationTarget`** on the destination platform.
   If it is "Liked"/"Favorites", or an existing playlist selected from the catalog
   dropdown, use it.
   If it is a free-text playlist name that does not exist yet on the destination side,
   **create it** as part of this step (and only it).
   Read the destination's current track set `D` for idempotency.
3. **For each `s ∈ S`** (in source order):
   - If `identity_key(s) ∈ D` already, emit `skipped (already present)` and continue.
   - Otherwise resolve `s` against the destination platform via the matcher (§7) —
     first the ledger's cached mapping, then live ISRC lookup, then scored search.
     On match, stage a write.
     On unmatched, emit an `unmatched` event with the source metadata and best rejected
     candidate, and continue.
4. **Apply the staged writes** in source order, in sequential batches
   (Apple strictly sequential, as §6.1 requires;
   Spotify can use slightly larger batches but still modest).
   Emit a status event per successful write and per failure.
   A single failure is recorded as a `failed` action and does **not** abort the Operation —
   the next item proceeds.
5. **Persist** the Operation record + full event log + summary counts to the ledger.

**Idempotency.**
Re-running the same Operation (same `source`, `destination`, `sourceTarget`,
`destinationTarget`) must result in zero new writes when the source has not changed,
because every item is already in `D`.
Verified explicitly in Phase 7 acceptance.

**Resumability.**
A crash mid-Operation is recoverable: the destination read in step 2 will include
everything already written, so the next run of the same Operation naturally skips those
items.
The ledger event log lets the UI replay status from where it left off.

**Concurrency.**
Only one Operation may run at a time.
The Run button is disabled while an Operation is active;
the server returns `409 Conflict` if a second Operation is POSTed.

---

## 9. Ledger schema (SQLite, `data/ledger.sqlite`)

```sql
-- forward-only schema version; db.ts migrates on startup (§12.5)
CREATE TABLE schema_version ( version INTEGER PRIMARY KEY );

-- canonical cross-service track identity + cached resolution
CREATE TABLE tracks (
  identity_key      TEXT PRIMARY KEY,   -- isrc OR fuzzy key
  isrc              TEXT,
  norm_title        TEXT,
  norm_artist       TEXT,
  duration_ms       INTEGER,
  spotify_id        TEXT,
  apple_catalog_id  TEXT,
  apple_library_id  TEXT,
  match_tier        TEXT,               -- 'isrc' | 'search' | 'unmatched'
  confidence        INTEGER,
  updated_at        TEXT
);

-- cached listing of the user's playlists per platform, populated by "Update Catalog"
CREATE TABLE catalog (
  platform     TEXT,             -- 'spotify' | 'apple'
  kind         TEXT,              -- 'playlist' | 'liked' | 'favorites'
  external_id  TEXT,              -- platform id (empty for liked/favorites singletons)
  name         TEXT,
  owner        TEXT,              -- spotify owner / apple curator (nullable)
  track_count  INTEGER,
  url          TEXT,              -- deep link (nullable)
  fetched_at   TEXT,
  PRIMARY KEY (platform, kind, external_id)
);

-- one row per Permissions preflight run (UI button or CLI `doctor`)
CREATE TABLE preflight_runs (
  id          TEXT PRIMARY KEY,   -- ulid/uuid
  started_at  TEXT,
  finished_at TEXT,                -- nullable while running
  status      TEXT,                -- 'running' | 'passed' | 'failed' | 'partial' | 'invalidated'
  trigger     TEXT,                -- 'manual' | 'cli' | 'auto-401' | 'auto-403-scope'
  surface     TEXT                  -- 'ui' | 'cli'
);

-- per-check result row, ordered by seq within a preflight run
CREATE TABLE preflight_checks (
  run_id      TEXT,
  seq         INTEGER,
  name        TEXT,                 -- v1: 'env' | 'spotify_token' | 'spotify_scopes' |
                                    -- 'spotify_me' | 'spotify_search' | 'apple_dev_token' |
                                    -- 'apple_mut' | 'apple_storefront' |
                                    -- 'apple_library_read' | 'apple_isrc_lookup'
                                    -- ('apple_delete_probe' returns if removals do; §6.2)
  status      TEXT,                 -- 'pass' | 'warn' | 'fail' | 'skip'
  detail      TEXT,                 -- JSON; MUST be redaction-safe (no tokens, no keys)
  duration_ms INTEGER,
  PRIMARY KEY (run_id, seq)
);

-- one row per Operation the human has run (or started running)
CREATE TABLE operations (
  id                 TEXT PRIMARY KEY,  -- ulid/uuid
  created_at         TEXT,
  finished_at        TEXT,              -- nullable while running
  source             TEXT,              -- 'spotify' | 'apple'
  destination        TEXT,              -- 'spotify' | 'apple'
  source_target      TEXT,              -- JSON { kind: 'playlist'|'liked'|'favorites', id?, name?, url? }
  destination_target TEXT,              -- JSON same shape
  status             TEXT,              -- 'queued' | 'running' | 'succeeded' | 'partial' | 'failed'
  summary            TEXT                -- JSON counts: read, matched, skipped, written, unmatched, failed
);

-- append-only, ordered event log per Operation; backs SSE live + replay
CREATE TABLE operation_events (
  operation_id TEXT,
  seq          INTEGER,
  ts           TEXT,
  type         TEXT,               -- 'stage' | 'match' | 'skip' | 'write' | 'unmatched' | 'error' | 'done'
  payload      TEXT,                -- JSON
  PRIMARY KEY (operation_id, seq)
);
```

The ledger is the source of truth for resumability, idempotency, and the SSE event-log
replay — not the live services.
Before creating a new playlist on the destination side (free-text name case),
check the catalog cache and the live library for an existing one with the same name to
avoid duplicates; if found, prefer the existing one and surface a confirmation in the UI.

---

## 10. Configuration

There is no `sync.config.json`.
Operations are constructed ad-hoc in the web UI;
what to transfer is _the_ thing the human is choosing each time.
Persistent configuration is limited to:

- **`.env`** — credentials only (see §4 for the exact key list). Git-ignored.
- **Built-in defaults** — the matching thresholds (`search_accept_threshold: 70`,
  `duration_tolerance_ms: 3000`, §7) live in `match/scoring.ts` as constants.
  If the human ever needs to tune them, they get a small "Advanced" disclosure in the UI
  that writes overrides to a `settings` table in the ledger;
  do not build this until asked.

The original `sync.config.example.json` template is removed by this amendment —
see Amendment log §15 (2026-06-03).

---

## 11. Surface — web UI + minimal CLI

### 11.1 Web UI (the primary surface)

Served at `http://127.0.0.1:8888/` by `src/http/server.ts`.
Vanilla HTML/CSS/JS in `web/`, no framework, no bundler.

One page, five panels (rendered top to bottom, in order):

1. **Auth status panel.**
   Shows whether Spotify and Apple Music are connected, with "Connect" / "Reconnect"
   buttons that drive the OAuth / MusicKit flows.
   The local server hosts the callbacks, so token capture is automatic and the human stays
   in the UI throughout.
2. **Permissions panel.**
   A single **Check permissions** button runs a comprehensive preflight that exercises
   every credential, scope, and read capability the tool depends on, before the human is
   allowed to refresh the catalog or run an Operation.
   Each check streams its result via SSE (pass / fail with a redacted detail line);
   the panel renders a live checklist grouped under three headings.

   **Ten checks, three groups. Ordering & skip semantics:**
   `env` runs first; if it fails, all downstream checks are recorded as `skip` with
   `detail="prerequisite env failed"`.
   After `env` passes, the Spotify group and the Apple group run **in parallel**
   (they are independent — one platform being broken should not block diagnostics on the
   other).
   Within each platform group, the checks run sequentially;
   if the first auth check (`spotify_token` or `apple_dev_token`) fails, the rest of that
   group is recorded as `skip`.

   **Group 1 — Environment**
   1. **`env`** — required `.env` keys present and non-empty:
      `SPOTIFY_CLIENT_ID`, `SPOTIFY_REDIRECT_URI`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and
      `APPLE_PRIVATE_KEY_PATH`.
      The `APPLE_PRIVATE_KEY_PATH` file must exist and be readable.

   **Group 2 — Spotify**
   2. **`spotify_token`** — Spotify access token valid;
      if expired, attempt refresh via the stored refresh token and report which path was
      used (`fresh` | `refreshed`).
   3. **`spotify_scopes`** — the granted scope list
      **persisted in `data/tokens.json`** (captured from the OAuth `scope` response field
      at initial token exchange and refreshed on every token refresh)
      covers every required scope:
      `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`,
      `playlist-modify-private`, `playlist-modify-public`, and `user-library-modify`.
      Failure detail lists the missing scope names and the remediation
      ("re-Connect Spotify to re-consent").
      Note for future agents: Spotify has no public token-introspection endpoint for PKCE
      clients — never invent one; the scope list lives in the local token cache.
   4. **`spotify_me`** — `GET /v1/me` returns a profile (proves auth header is accepted).
   5. **`spotify_search`** — a low-cardinality `GET /v1/search?type=track&q=...&limit=1`
      returns ≥ 1 result (proves catalog read works — what matching depends on).

   **Group 3 — Apple**
   6. **`apple_dev_token`** — the JWT signs successfully from the `.p8`
      (regenerate if within 7 days of expiry per §5.2);
      decode locally to confirm `iss`, `kid`, and `exp` are sane.
   7. **`apple_mut`** — Music-User-Token present and accepted by a trivial authorized call.
   8. **`apple_storefront`** — `GET /v1/me/storefront` resolves;
      record the storefront id (this is also where the storefront cache for the rest of
      the session warms).
   9. **`apple_library_read`** — `GET /v1/me/library/playlists?limit=1` succeeds
      (proves MUT + library scope on the dev token).
   10. **`apple_isrc_lookup`** — a known-good ISRC lookup in the resolved storefront
       returns at least one validated (non-404) candidate
       (proves catalog read + matching plumbing).

   The §6.2 Apple delete-capability probe is **not** part of preflight in v1 —
   see §6.2 and the Amendment log (2026-06-03 #2).
   It returns when removals return.

   **Gating policy** (enforced both client-side as button disable, and server-side as
   `412 Precondition Failed` on `POST /api/catalog/refresh` and `POST /api/operations`):

   The gate is **open** iff the latest `preflight_runs` row satisfies **all** of:
   - `status = 'passed'` (every non-skip check passed; no failures), AND
   - `finished_at` is within the last **24 hours**
     (soft expiry — overnight drift like a revoked Spotify authorization or an expired MUT
     gets caught at the door rather than mid-Operation), AND
   - no `invalidated` row has been inserted since (see auto-invalidation below).

   Otherwise the gate is **closed**:
   Catalog refresh and Operation Run are disabled with contextual hover text
   ("Re-check permissions required: last pass was 38h ago", or
   "Re-check required: Spotify auth failed since last pass"),
   and the corresponding POST endpoints return `412` with a body explaining the reason.
   The UI panel always offers a **Re-check** button.

   **Auto-invalidation** is **refresh-aware**:
   `util/http.ts` catches 401 by attempting one token refresh (Spotify) or one dev-token
   re-sign (Apple) and retrying the request.
   Only if the **retry** still returns 401 — or returns a 403 whose body indicates a
   scope/permission problem (not a rate-limit) — does the server insert a new
   `preflight_runs` row with `status='invalidated'` and `trigger='auto-401'`
   (or `'auto-403-scope'`).
   Rate-limit 403s, transient 401s recovered by refresh, and any 5xx do not invalidate the
   gate.

3. **Catalog panel.**
   An **Update Catalog** button fetches the user's playlists from each connected platform
   and stores them in the `catalog` table;
   live progress streams via SSE from `/api/catalog/events`.
   After a refresh, the Operation form's dropdowns repopulate.
   The panel also shows when each platform's catalog was last fetched.
   This panel is disabled when the preflight gate has not passed.
4. **Operation form.** Fields:
   - `Source` — radio (Spotify / Apple)
   - `Destination` — radio (Spotify / Apple), auto-filtered so it cannot equal `Source`
   - `Source Target` — a dropdown of the source's cached playlists
     (with the platform's Liked/Favorites pinned at the top),
     **plus** a free-text input for a playlist id / URL / name.
     The dropdown and the input are mutually exclusive;
     selecting Liked/Favorites disables the input.
   - `Destination Target` — same shape, on the destination side.
     The free-text input here accepts an existing playlist (id / URL / name) **or** a new
     name to be created.
     Selecting Favorites/Liked disables the input.
   - **Run** — submits the Operation.
     Disabled when **preflight has not passed**, when source ≡ destination, when either
     side is unauthorized, when both target fields on a side are empty, or when an
     Operation is already running.
5. **Run panel.**
   When an Operation is running or has just finished, this panel shows:
   current stage (resolving source → reading destination → matching → writing → done),
   a progress bar (written / matched out of total),
   a scrollable event log (one line per match, skip, write, unmatched, failure),
   and a final summary card with counts and a copyable JSON summary.
   The panel also has a "Past operations" disclosure that lists prior operations from the
   ledger.

### 11.2 HTTP API (consumed by the UI; documented for diagnostics)

```
GET    /api/health                  liveness
GET    /api/auth/status             { spotify: {connected, expiresAt?}, apple: {connected, expiresAt?} }
POST   /api/auth/spotify/start      returns { authorizeUrl } the UI opens in a popup
GET    /auth/spotify/callback       Spotify redirects here; server stores tokens; closes popup
POST   /api/auth/apple/start        returns { developerToken } for MusicKit JS in the popup
POST   /api/auth/apple/callback     popup POSTs the MUT here; server stores it; closes popup
GET    /api/preflight/latest        latest preflight_runs row + its checks; null if none
POST   /api/preflight/run           starts a new preflight; returns { id }; 409 if one is running
GET    /api/preflight/:id           a specific preflight_runs row + its checks
GET    /api/preflight/:id/events    SSE: per-check live events (and replay from the ledger)
GET    /api/catalog                 current cached catalog, both platforms
POST   /api/catalog/refresh         kicks off a refresh of both connected platforms
                                    returns 412 if preflight gate has not passed
GET    /api/catalog/events          SSE: refresh progress
POST   /api/operations              body: { source, destination, sourceTarget, destinationTarget }
                                    returns { id }; 409 if another Operation is running;
                                    412 if preflight gate has not passed
GET    /api/operations              recent operations list (from ledger)
GET    /api/operations/:id          operation record + summary
GET    /api/operations/:id/events   SSE: live events (and replay from the ledger on reconnect)
```

### 11.3 Minimal CLI

```
npx tsx src/server.ts        # start the UI server (default; opens the browser)
npx tsx src/cli.ts doctor    # runs the same 10 preflight checks as the UI button
```

The auth flows live behind the UI's auth panel — there are no separate `auth spotify` /
`auth apple` CLI commands in v1.
The CLI exists only for headless health-checking, and for the agent itself to verify
environment state at the credential pause points.
`doctor` is just a thin CLI surface over `preflight/runner.ts` —
it runs exactly the same checks the UI's **Check permissions** button runs,
writes the same `preflight_runs` / `preflight_checks` rows (with `surface='cli'`),
and prints a pretty checklist.
A `doctor` pass counts for the UI's gating policy, and vice versa.

---

## 12. Reliability, privacy, durability requirements

- **Rate limits / backoff:**
  wrap all HTTP in `util/http.ts` with exponential backoff + jitter on 429/5xx,
  honoring `Retry-After`.
  Single worker, modest concurrency cap.
  An Operation is not latency-sensitive; completeness beats speed.
- **Idempotency:**
  re-running the same Operation with no upstream changes must produce zero writes and an
  empty action set.
  Verify this explicitly in Phase 7 acceptance.
- **Resumability:** crash mid-Operation → restart skips work already recorded in the
  ledger (and the next read of `D` reflects whatever was already written).
- **No secret leakage:**
  `util/log.ts` must redact tokens, keys, and auth headers.
  Never log a full request with `Authorization` / `Music-User-Token`.
  Never echo secrets to chat.
- **No personal data in git:** `data/` is gitignored;
  it contains playlist contents, tokens, and the per-Operation event log.
- **Token storage:** `data/tokens.json`, gitignored, restrictive file permissions
  (0600 where the OS supports it).

### 12.5 Self-healing (runtime)

The tool must keep itself working as the world drifts, without a human babysitting it:

- **Schema migrations.**
  The ledger carries a `schema_version`; on startup, migrate forward automatically.
  Never make the human hand-edit the database.
  Adding columns/tables later is expected — that's the implementation tier evolving (§0).
- **Capability re-probing.**
  Re-run any gated capability before acting on it, and on a sensible cadence via
  `doctor` / the UI's Permissions panel.
  If a capability that previously passed now fails, fall back to report-only and warn —
  never assume yesterday's probe still holds.
  (In v1 there is no gated capability in active use: the Apple delete-probe is deferred per
  §6.2. This bullet returns to active duty whenever a gated capability is re-introduced.)
- **Token healing.**
  Auto-refresh the Spotify token and auto-regenerate the Apple developer token near expiry.
  When the MUT cannot be refreshed, fail with a clear "click **Reconnect Apple Music** in
  the Auth panel" message in the SSE error stream, not a raw 401.
- **Endpoint-drift detection.**
  If a known endpoint starts failing in a way that suggests it changed (persistent 4xx on a
  call that should succeed), surface it loudly and — for the volatile routes in §6 —
  re-verify before continuing.
  Never let drift silently corrupt the ledger.
- **Match revalidation.**
  Expose a "rematch" option (an Advanced toggle on the Operation form, or a
  `?rematch=true` query param on `POST /api/operations`) that invalidates cached mappings
  and re-resolves (e.g. when a catalog's canonical id changes).
  A stale mapping whose target id now 404s should be detected and re-resolved
  automatically.
- **Graceful degradation.**
  A single failed track add is recorded as a `failed` action and retried on the next run;
  it never aborts the whole Operation.
  Partial progress is always persisted.

---

## 13. Build phases & acceptance criteria (execute in order)

Each phase ends with a commit (see `CLAUDE.md` git workflow) and a `PROGRESS.md` entry.

- **Phase 0 — Scaffold.**
  Repo, `git init`, `.gitignore` (✅ before any other file), `package.json`, `tsconfig`,
  ESLint/Prettier, `.env.example`, an empty `web/index.html` placeholder, README skeleton,
  and `PROGRESS.md`.
  **AC:** `npm run build` passes; `git status` shows no secret/data paths trackable;
  the obsolete `sync.config.example.json` has been removed (per §10).
- **Phase 1 — Ledger + HTTP server skeleton.**
  `config.ts`, `ledger/db.ts` with the §9 schema and forward-migration runner,
  `http/server.ts` serving `/api/health` and static `/web/` assets,
  `src/server.ts` entrypoint.
  **AC:** `npx tsx src/server.ts` starts the server, the UI loads in a browser and shows
  the health-check result, `data/ledger.sqlite` is created with all tables and a
  `schema_version` row.
- **Phase 2 — Spotify auth + read.**
  PKCE flow wired through the UI's auth panel; loopback callback served by the same HTTP
  server; refresh; read client (playlists, playlist tracks, Liked).
  Persist the `scope` field returned at token exchange (and at each refresh) into
  `data/tokens.json` so `spotify_scopes` in Phase 5 has data to read.
  **AC:** after ⏸A/⏸B, the UI shows Spotify connected;
  the read client returns the user's Spotify playlists + Liked with ISRCs on a sample
  tracklist.
- **Phase 3 — Apple auth + read.**
  Dev-token signing, MusicKit page at `/auth/apple/musickit`, MUT capture POSTed back to
  the server; storefront resolution; read client (library playlists, Favorites, catalog
  search, ISRC lookup).
  **AC:** after ⏸C/⏸D, the UI shows Apple connected;
  storefront resolves and the read client returns library playlists + Favorites + a known
  ISRC lookup.
  (The §6.2 delete-capability probe is **deferred** per the 2026-06-03 amendment — do not
  implement it in v1.)
- **Phase 4 — Matching.**
  `identity`, `scoring`, `matcher` for both directions; ledger-backed match cache.
  **AC:** a known explicit Spotify track resolves to the explicit Apple master via ISRC
  (not the clean version);
  a no-ISRC track resolves via scored search or is flagged unmatched;
  symmetric Apple→Spotify works.
- **Phase 5 — Permissions preflight + gating.**
  `preflight/checks.ts` + `preflight/runner.ts`;
  `/api/preflight/*` endpoints + SSE;
  the UI's Permissions panel with the **Check permissions** button and the live checklist
  (grouped Environment / Spotify / Apple, with intra-group skips when a prerequisite fails);
  the gating policy enforced both client-side (Catalog and Run buttons disabled with
  contextual hover text) and server-side (412 on `POST /api/catalog/refresh` and
  `POST /api/operations` when not gated open);
  refresh-aware auto-invalidation in `util/http.ts` (one token refresh / dev-token re-sign
  and retry before invalidating).
  The `doctor` CLI is wired to the same orchestrator with `surface='cli'`.
  **AC:**
  1. With valid creds, **Check permissions** runs the 10 checks (env first, then Spotify
     and Apple groups in parallel).
     Each check streams a pass/fail event with a redaction-safe detail line;
     the gate flips to "passed" and the Catalog/Run controls enable.
  2. With a deliberately missing scope (e.g. re-consenting without `user-library-modify`),
     `spotify_scopes` fails with the missing-scope name and remediation;
     gate stays closed.
  3. With a missing env key, all downstream checks record `skip` and the gate stays closed.
  4. Backdating the latest `preflight_runs.finished_at` to >24h ago closes the gate,
     and `POST /api/catalog/refresh` returns 412 with the "soft expiry" reason.
  5. Simulating a 401 from a Spotify call: `util/http.ts` refreshes and retries once;
     if the retry succeeds, the gate stays open and no invalidation row is written.
     If the retry still 401s, an `invalidated` row with `trigger='auto-401'` is written
     and the UI prompts a re-check.
     Same shape for Apple (re-sign + retry).
     A 403 with a scope-error body invalidates with `trigger='auto-403-scope'`;
     a rate-limit 403 does not invalidate.
  6. A `doctor` pass written from the CLI satisfies the UI's gate
     (the UI re-fetches `/api/preflight/latest` and the gate opens), and vice versa.
- **Phase 6 — Catalog cache + Operation form UI.**
  `catalog/catalog.ts` + `/api/catalog/*` endpoints + SSE refresh stream;
  the UI's Operation form populates dropdowns from the cache,
  enforces source ≠ destination, and disables the free-text input when Liked/Favorites is
  selected.
  **AC:** clicking **Update Catalog** refreshes both sides with live progress;
  the dropdowns populate;
  the Run button enables only when preflight has passed, both targets are resolved,
  and an Operation is not already running.
- **Phase 7 — Operation runner + live status.**
  `operation/runner.ts` executes the additive transfer per §8,
  emits SSE events through `/api/operations/:id/events`,
  persists the event log + summary to the ledger;
  the Run panel streams status.
  **AC:** an Operation moves missing tracks from S to D and skips items already in D;
  a second run of the same Operation writes zero (idempotent);
  a mid-run failure is recorded and does not abort;
  reconnecting to the SSE stream replays prior events from the ledger.
- **Phase 8 — UX polish.**
  Helpful errors at each pause point (named env var, exact next click);
  the UI surfaces a reconnect prompt on 401 (in addition to the auto-invalidation from
  Phase 5);
  `util/log.ts` redacts `Authorization` and `Music-User-Token`;
  the event log is readable and copyable.
  **AC:** all surfaces are documented and working; logs never contain tokens.
- **Phase 9 — Publish prep.**
  Final secrets audit, README setup walkthrough, license.
  **AC:** clean repo, no secrets/data tracked.
  **⏸ PAUSE POINT E (optional):** ask the human before creating or pushing to a GitHub
  remote; do not create the remote autonomously.

---

## 14. Definition of done

- All nine phases pass their acceptance criteria.
- The UI's **Check permissions** button runs the full 10-check preflight
  (env, Spotify ×4, Apple ×5);
  all checks pass on a correctly configured environment;
  the gating policy (latest pass within 24h, refresh-aware auto-invalidation) prevents
  catalog refresh and Operations whenever it should.
- The web UI can run, end-to-end, an Operation from a real Spotify playlist to a real
  Apple Music playlist **and** the symmetric Apple → Spotify direction, verified by the
  human.
  At least one of those Operations uses Liked/Favorites on one side.
- Re-running the same Operation with no source changes writes nothing (idempotent).
- `doctor` (CLI) and the UI's Permissions panel agree —
  a `doctor` pass satisfies the UI's gate, and a UI pass shows up in `doctor`'s history.
- README explains setup (incl. the four credential pause points + the preflight step),
  how to launch the UI, and the additive-only / no-removals posture honestly.
- A secrets audit confirms the public repo is clean:
  no `.p8`, no `.env`, no tokens, no `data/`, no `web/` assets containing personal data.

---

## 15. Amendment log

This blueprint is a living document (§0).
Whenever you change anything in the **implementation** tier, append a row here.
Leave the **invariants** tier untouched unless the human explicitly amends it —
and if they do, record that too, attributed to the human.

| Date       | Section(s)                                        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Rationale                                                                                                                                                                                                        | Invariants confirmed intact                                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _seed_     | —                                                 | Initial blueprint authored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Starting point                                                                                                                                                                                                   | n/a                                                                                                                                                                                                                                                                                                  |
| 2026-06-03 | preamble, §1, §3, §8, §9, §10, §11, §13, §14, §15 | **Pivot from CLI bidirectional sync → local web UI for one-time additive Operations** (human-directed). Operation = `{source, destination, sourceTarget, destinationTarget}`; targets ∈ `{playlist, liked, favorites}`. Removed `sync_pairs`/`baseline` tables and the three-way-merge engine; removed removal propagation and `--allow-removals`; removed `sync.config.json` (operations are ad-hoc in the UI). Added `catalog`, `operations`, `operation_events` tables; HTTP server with SSE; `web/` vanilla-JS UI. Kept all auth, matching, API-hazards, and reliability/redaction design.                                                                                                       | Human asked for a web UI driving one-time transfers with live status and a catalog-backed playlist picker. The simpler unidirectional model fits the new UX and removes a large class of reconciliation hazards. | Non-destruction strengthened (no removal code path at all in v1). Secrets/privacy unchanged. Truthfulness unchanged. Auditability preserved via `operations` + `operation_events`. Scope still bounded (single-user, local).                                                                         |
| 2026-06-03 | §1, §3, §9, §11, §13, §14, §15                    | **Added a "Check permissions" preflight that gates Catalog and Operations** (human-directed). New 11-check sequence (env, both tokens, Spotify scopes, sample reads on each side, ISRC lookup, Apple delete-probe) runs from the UI's Permissions panel and from the CLI `doctor` via shared `preflight/runner.ts`. Catalog refresh + Operation runs are disabled UI-side and refused (412) server-side until the latest `preflight_runs` row is `passed`. A 401/403 from any downstream call auto-invalidates the pass. Added `preflight_runs` + `preflight_checks` tables and `src/preflight/`. Inserted as new Phase 5; pushed Catalog/UI to 6, Operation runner to 7, Polish to 8, Publish to 9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Human asked to fail fast at the door — exercise every credential, scope, and capability the tool relies on before any catalog or Operation action, instead of discovering a missing scope mid-Operation.                                                                                              | Non-destruction unchanged (preflight only reads, plus the throwaway delete-probe per §6.2 which cleans up after itself). Secrets/privacy unchanged (`detail` column must be redaction-safe). Truthfulness unchanged (preflight is the runtime verifier). Auditability strengthened. Scope unchanged.                                |
| 2026-06-03 | §1, §6.2, §9, §11.1, §13, §14, §15                | **Preflight design tightened after a validation pass on five concerns**: (1) gate now requires latest `passed` AND `finished_at` within 24h (soft expiry catches overnight drift); (2) **`apple_delete_probe` removed from v1 preflight** — v1 deletes nothing, so the probe is deferred along with removals (§6.2 now states this explicitly); the check list is now 10, not 11. (3) Auto-invalidation is refresh-aware: `util/http.ts` attempts one token refresh / dev-token re-sign + retry; only the second 401, or a 403 whose body indicates a scope problem (not rate-limit), invalidates the gate (`trigger='auto-401'` or `'auto-403-scope'`). (4) `spotify_scopes` is implemented by reading the granted scope list **persisted in `data/tokens.json`** from the OAuth `scope` response field — Spotify has no public token-introspection endpoint for PKCE clients, and inventing one would violate the truthfulness invariant. (5) Ten checks remain fine-grained but are presented in three UI groups (Environment / Spotify / Apple), env-first, Spotify and Apple groups run in parallel, intra-group skips when a prerequisite fails. Phase 5 AC rewritten as six numbered subcriteria. | Human asked to deeply validate and resolve the five open concerns I raised against the previous amendment. Each resolution favors safety (fail-fast, no invented endpoints), accuracy (refresh-aware invalidation reduces false-positives), and clarity (grouped UI, scoped detail messages). | Non-destruction unchanged. Secrets/privacy unchanged (scope list persisted alongside refresh token in already-gitignored `data/tokens.json`). Truthfulness **strengthened**: scope-check implementation explicitly forbids inventing an introspection endpoint; delete-probe deferral removes a latent untested code path. Auditability unchanged. Scope unchanged. |

> Keep entries terse — one line each.
> The point is a traceable history of _why the design is what it is now_,
> so a future you (or a future agent) can tell deliberate evolution apart from drift.

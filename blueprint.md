<!-- @format -->

# Blueprint — `spotify-to-apple-music`

A personal, self-hosted CLI tool for **bidirectional playlist sync** between Spotify and
Apple Music, with intelligent recording-level matching (ISRC-first) so that the _correct
version_ of each track is synced — not a remix, not the clean edit when an explicit master
exists, not a re-release.

This document is the **source of truth** for an autonomous coding agent (Claude Code). It is
written to be executed near-hands-off. The only times the agent should stop and hand control
back to the human are clearly marked **`⏸ PAUSE POINT`** blocks (all of which are
credential/sign-in steps). Everything else the agent builds, verifies, and commits on its own.

Operating rules for _how_ the agent should work live in `CLAUDE.md`. This file describes _what_
to build and _why_. Read both before starting.

---

## 0. Governing principle — a living, self-healing blueprint

This project is **not** a fixed contract to implement once and freeze. It is a **living system**
that must keep working as platform APIs, the owner's needs, and your own understanding change.
Treat both this blueprint and `CLAUDE.md` as documents you are _expected to amend_ as you learn.
Rigid, frozen requirements would guarantee failure the moment Apple or Spotify shifts an endpoint.

Two tiers govern every decision. Knowing which tier a thing belongs to is the whole game.

**Invariants — never weaken these.** They are the reason the tool is trustworthy. You may _add_ to
them; you may never edit, soften, or route around them.

1. **Non-destruction.** Additive-union by default. No deletion of user data without explicit
   per-run opt-in, a passed capability probe where the platform needs one, and a confirmation pause.
2. **Secrets & privacy.** Never commit or print secrets or personal data; always redact; Spotify
   stays secret-less (PKCE).
3. **Truthfulness.** Never invent an API endpoint or capability. Verify the volatile parts against
   live behavior/docs; when unverifiable, degrade to report-only and say so.
4. **Auditability.** Every run resumable; every decision recorded in the ledger.
5. **No autonomous scope creep.** Don't expand beyond §1 scope on your own. The human may amend
   scope; you don't grow it unilaterally.

**Implementation — evolve this freely.** Everything else is a _current best guess, not a mandate_:
the tech stack, schema, phase ordering, matching heuristics and thresholds, endpoint routes, file
layout. When you find a better or more correct approach, **change it** — then log it (§15) and keep
the rest of the document consistent with the change.

**Self-healing is a runtime requirement too**, not just a build-time stance — see §12.5. The
finished tool must detect drift (changed endpoints, regressed capabilities, expired tokens, stale
matches) and recover or degrade gracefully rather than corrupt state or fail silently.

**Change protocol — follow this whenever you amend the spec:**

- Make the smallest change that solves the problem; preserve every invariant.
- Update _all_ affected sections so the document stays internally consistent (no stale schema or
  endpoint left elsewhere).
- Append a dated entry to the Amendment log (§15): what changed, why, and which invariants you
  confirmed remain intact.
- If a change would weaken an invariant or expand scope, **do not** — stop and ask the human.

---

## 1. North star & scope

**Goal:** Keep chosen Spotify playlists and Apple Music playlists in sync, in both directions,
on demand (run a command), safely (never destroys data by surprise), and idempotently (re-running
changes nothing if nothing changed).

**In scope**

- Sync arbitrary Spotify playlist ⇆ Apple Music playlist pairs (configured by the user).
- Sync Spotify **Liked Songs** ⇆ Apple Music **Favorite Songs** as a special pair.
- Intelligent matching: same recording on both sides via ISRC, with a scored search fallback.
- Dry-run planning with human-readable reports before any write.
- A durable local ledger (SQLite) that makes every run resumable, idempotent, and auditable.
- Publishable to a public GitHub repo with **zero** secrets or personal data tracked.

**Explicitly out of scope** (do not build): multi-user support, a hosted service, a GUI/web app,
distribution/packaging for others, real-time/continuous daemon syncing (this is run-on-demand),
and any account-creation or payment flows.

**Non-negotiable safety posture:** additive-union by default. The tool _adds_ missing tracks to
each side. It does **not** delete anything unless the human explicitly opts in per-run, and even
then only where the platform API actually supports it (see §6).

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

Keep the dependency tree minimal. Prefer the standard library. Every added dependency must be
justified in `PROGRESS.md`.

---

## 3. Repository layout (target)

```
spotify-to-apple-music/
├─ blueprint.md                 # this file (tracked)
├─ CLAUDE.md                    # agent operating manual (tracked)
├─ README.md                    # human setup + usage (tracked)
├─ PROGRESS.md                  # agent's running build log (tracked)
├─ package.json / tsconfig.json # (tracked)
├─ .gitignore                   # (tracked)
├─ .env.example                 # template, no real values (tracked)
├─ sync.config.example.json     # template pair definitions (tracked)
├─ src/
│  ├─ cli.ts                    # command router / entrypoint
│  ├─ config.ts                 # load + validate sync.config.json and env
│  ├─ auth/
│  │  ├─ spotify.ts             # Authorization Code + PKCE, token refresh
│  │  └─ apple.ts               # dev-token JWT + Music-User-Token capture
│  ├─ clients/
│  │  ├─ spotify.ts             # read + write wrapper
│  │  └─ apple.ts               # read + write wrapper + capability probing
│  ├─ match/
│  │  ├─ identity.ts            # ISRC normalization + fuzzy fallback key
│  │  ├─ scoring.ts             # candidate scoring for the search fallback
│  │  └─ matcher.ts             # tiered matching, both directions
│  ├─ sync/
│  │  ├─ engine.ts              # three-way merge orchestration
│  │  ├─ planner.ts             # diff → action plan
│  │  └─ applier.ts             # execute plan (dry-run aware)
│  ├─ ledger/
│  │  └─ db.ts                  # schema + queries
│  ├─ report/
│  │  └─ reports.ts             # unmatched / conflicts / review CSV+MD
│  └─ util/
│     ├─ http.ts                # fetch with backoff, 429/Retry-After handling
│     └─ log.ts                 # structured logging that NEVER prints secrets
├─ data/                        # GITIGNORED: sync.sqlite, tokens.json
├─ secrets/                     # GITIGNORED: AuthKey_*.p8
└─ reports/                     # GITIGNORED: contains personal playlist data
```

---

## 4. Secrets & GitHub hygiene (must be correct from Phase 0)

This repo goes public. Treat everything that identifies the owner or grants account access as
radioactive.

**Never tracked (must be in `.gitignore` before the first commit):**

```
node_modules/
dist/
.env
*.p8
secrets/
data/
reports/
tokens.json
*.sqlite
*.sqlite-journal
.DS_Store
```

**Tracked, but templated only (no real values):** `.env.example`, `sync.config.example.json`.

**Secrets live in `.env`** (gitignored). The Apple private key file lives in `secrets/`
(gitignored). Tokens captured at runtime (Spotify refresh token, Apple MUT) are written to
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

Note: Spotify uses PKCE, so there is **no client secret** to store — good. Do not introduce one.

Before any commit, run a secrets audit (see `CLAUDE.md` §git workflow). At minimum: confirm
`git status` shows none of the gitignored paths, and grep the staged diff for the values of
`APPLE_TEAM_ID`, `APPLE_KEY_ID`, any `BEGIN PRIVATE KEY`, and any captured token.

---

## 5. Authentication design

### 5.1 Spotify — Authorization Code with PKCE

- Scopes (read **and** write, since sync is bidirectional):
  `playlist-read-private playlist-read-collaborative user-library-read`
  `playlist-modify-private playlist-modify-public user-library-modify`
- Flow: generate code verifier/challenge → open browser to `/authorize` → user approves →
  Spotify redirects to the loopback `SPOTIFY_REDIRECT_URI` → local `http` server captures the
  `code` → exchange for access + refresh tokens → persist refresh token to `data/tokens.json`.
- Refresh tokens automatically on 401 / expiry. Never require re-consent unless the refresh
  token is revoked.

> **⏸ PAUSE POINT A — Spotify app registration.** The agent cannot create the Spotify app. When
> reaching Phase 2, stop and instruct the human: create an app at the Spotify Developer
> Dashboard, copy the **Client ID** into `.env` as `SPOTIFY_CLIENT_ID`, and add the redirect URI
> `http://127.0.0.1:8888/callback` to the app's settings. Then resume.

> **⏸ PAUSE POINT B — Spotify consent.** Run `auth spotify`; the agent opens the browser and
> serves the callback. The human logs in and approves. Token capture is automatic; resume.

### 5.2 Apple Music — developer token + Music-User-Token

Two distinct tokens are required for any library write:

1. **Developer token** — a JWT the tool signs itself with the `.p8` key, proving app identity.
   - Sign with **ES256**, `iss` = Team ID, `kid` = Key ID, max lifetime 6 months. Regenerate
     automatically when it is within ~7 days of expiry.
   - Reference contract:
     ```ts
     jwt.sign({}, privateKeyPem, {
       algorithm: "ES256",
       expiresIn: "180d",
       issuer: APPLE_TEAM_ID,
       header: { alg: "ES256", kid: APPLE_KEY_ID },
     });
     ```
2. **Music-User-Token (MUT)** — proves the human authorized this app to touch their library.
   Obtained via MusicKit JS in a browser: the agent serves a tiny local static page that loads
   MusicKit JS v3, configures it with the developer token, calls `authorize()`, and POSTs the
   returned MUT back to the local server, which persists it to `data/tokens.json`.

Every Apple write call sends both: `Authorization: Bearer <devToken>` **and**
`Music-User-Token: <mut>`.

Always resolve the storefront dynamically from `GET /v1/me/storefront` — **never hardcode `us`**.
ISRC availability is per-storefront and the owner's storefront may differ.

> **⏸ PAUSE POINT C — Apple Developer setup.** The human has an Apple Developer membership. When
> reaching Phase 3, stop and instruct: in Certificates, Identifiers & Profiles, register a Media
> Identifier and create a **MusicKit** private key; download the `.p8` into `secrets/`; put the
> **Team ID** and **Key ID** into `.env`. Then resume.

> **⏸ PAUSE POINT D — Apple authorization.** Run `auth apple`; the agent serves the local
> MusicKit page. The human clicks Authorize and approves Apple Music access. MUT capture is
> automatic; resume.

---

## 6. API reality notes (verified at authoring — the agent MUST re-verify via `doctor`)

These constraints shape the whole sync model. They are also the parts of the platform APIs most
likely to drift, so the agent treats them as a strong prior and confirms each at build time with
a live capability probe rather than trusting this document blindly.

1. **Apple playlist writes are append-only.** The API adds tracks to the _end_ of an editable
   library playlist; there is no insert-at-position and no reorder. Add in source order, in
   sequential (not concurrent) batches.
2. **Apple playlist track _removal_ via REST is unreliable/unsupported.** Apple's developer
   relations have repeatedly stated the API supports only _adding_ to the cloud library and
   editable playlists. Some clients report removal working only for playlists created through
   MusicKit's native `createPlaylist`, and not for playlists created via the REST API; others
   with `canEdit=true` find no working REST delete. **Therefore: Apple-side removals are
   report-only by default.** The agent must implement a runtime probe (create a throwaway test
   playlist, add a track, attempt removal, observe the result, then clean up) and gate any
   removal feature behind that probe's success.
3. **Apple Favorites are one-way from third parties.** A song can be favorited via the API, but
   it **cannot be un-favorited** by a third-party app — only inside the Apple Music app itself.
   So Liked⇆Favorites removals on the Apple side are always report-only. Also: the exact REST
   route for _favoriting a song_ has shifted (a dedicated favorites capability now exists
   alongside the older `PUT /v1/me/ratings/songs/{id}` with value `1`). The agent must verify the
   current correct endpoint against live Apple documentation before wiring it, and must not
   invent a route.
4. **ISRC lookup can return multiple results and dead entries.** `filter[isrc]` may return
   several songs (same recording across single/album/deluxe) and some results 404 when fetched.
   Never blindly take `data[0]`; disambiguate (see §7) and validate the chosen candidate.
5. **Spotify is the more capable side.** Spotify supports reading + adding + **removing** tracks
   from playlists and saved tracks. So removals _can_ be applied on the Spotify side (still
   opt-in and confirmed, because they are destructive).

Net effect on direction symmetry:

| Operation                  | Spotify side          | Apple side                         |
| -------------------------- | --------------------- | ---------------------------------- |
| Add track to playlist      | ✅ supported          | ✅ supported (append-only)         |
| Remove track from playlist | ✅ supported (opt-in) | ⚠️ report-only unless probe passes |
| Save / Like a track        | ✅ supported          | ✅ supported (favorite)            |
| Unsave / Unfavorite        | ✅ supported (opt-in) | ❌ report-only (API can't)         |
| Reorder                    | ✅ supported          | ❌ not supported                   |

The tool therefore guarantees **convergence on additions** in both directions, and **best-effort,
opt-in, capability-gated** behavior on removals. This asymmetry must be stated plainly in the
README so the owner has correct expectations.

---

## 7. Matching engine (recording-level, both directions)

Identity is anchored on **ISRC** — a globally unique code for a _specific recording_. Distinct
recordings (remix, edit, live, remaster, clean vs. explicit) carry distinct ISRCs, so matching on
ISRC inherently selects the correct version. Spotify exposes it at `track.external_ids.isrc`;
Apple exposes it at `attributes.isrc` and accepts it via `filter[isrc]`. Spotify search also
accepts `q=isrc:<code>`, so the engine is symmetric.

**Tier 1 — ISRC exact.**

- Spotify→Apple: `GET /v1/catalog/{storefront}/songs?filter[isrc]=<isrc>` (batch up to 25 ISRCs).
- Apple→Spotify: `GET /v1/search?q=isrc:<isrc>&type=track`.
- Disambiguate multiple results deterministically: prefer the candidate whose album matches the
  source album → then a non-compilation / non-"Greatest Hits" album → then the first _validated_
  (non-404, fully-attributed) candidate. Selection must be stable across re-runs.

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

- Accept the top candidate only if score ≥ **70**. Below threshold → **unmatched report**, never
  a guess. The explicit-flag rule and the variant penalty are what preserve "correct version"
  once the ISRC guarantee is gone.

**Tier 3 — unmatched.** Write to `reports/unmatched-<pair>-<timestamp>.csv` with source metadata,
both-platform deep links, and the best rejected candidate + its score, so the human can resolve
the long tail in minutes.

Every resolved mapping (source ID ⇆ ISRC ⇆ target ID, tier, confidence) is cached in the ledger
so future runs skip re-matching.

---

## 8. Sync engine — three-way merge

True bidirectional sync requires distinguishing "added on side A" from "deleted on side B". That
demands a stored **baseline**: the reconciled state at the end of the last successful sync. This
is the same model every file-sync system uses, and it is the only correct way to avoid
resurrecting deleted tracks or silently dropping new ones.

**Identity key** for set math: ISRC when present; otherwise a normalized
`title|artist|durationBucket` fuzzy key flagged low-confidence.

**Per pair, per run:**

1. Read current Spotify set `S` and current Apple set `A`.
2. Load baseline `B` (empty on first sync → first sync is a pure union, additive).
3. Compute, against `B`:
   - `addedOnSpotify   = S \ B`
   - `removedOnSpotify = B \ S`
   - `addedOnApple     = A \ B`
   - `removedOnApple   = B \ A`
4. Build the plan:
   - **Additions (always, both directions):** items in `addedOnSpotify` missing from `A` → add to
     Apple; items in `addedOnApple` missing from `S` → add to Spotify. Dedupe by identity key;
     skip anything already present on the target.
   - **Removals (opt-in only, `--allow-removals`):**
     - `removedOnSpotify` → remove from Apple: **report-only** unless the Apple delete probe
       passed; if it passed and the flag is set, apply.
     - `removedOnApple` → remove from Spotify: apply only with the flag set, after a confirmation
       pause; otherwise report-only.
   - **Conflicts:** an item added on one side _and_ removed on the other since the baseline →
     never auto-resolve; write to the conflicts report and leave both sides untouched.
5. Apply the plan (or, in dry-run, only render reports).
6. Write the new baseline = the reconciled present state, with resolved IDs for both platforms.

First-run behavior (no baseline): pure additive union — both sides end up containing the union of
both, nothing is ever removed.

---

## 9. Ledger schema (SQLite, `data/sync.sqlite`)

```sql
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

-- a configured playlist pairing
CREATE TABLE sync_pairs (
  id                 TEXT PRIMARY KEY,  -- from sync.config.json
  name               TEXT,
  spotify_playlist   TEXT,              -- playlist id OR 'liked'
  apple_playlist     TEXT,              -- library playlist id OR 'favorites'
  direction          TEXT,              -- 'both' | 's2a' | 'a2s'
  created_at         TEXT
);

-- reconciled snapshot after the last successful sync (the merge baseline)
CREATE TABLE baseline (
  pair_id       TEXT,
  identity_key  TEXT,
  spotify_id    TEXT,
  apple_id      TEXT,
  last_synced   TEXT,
  PRIMARY KEY (pair_id, identity_key)
);

CREATE TABLE sync_runs (
  id         TEXT PRIMARY KEY,
  pair_id    TEXT,
  mode       TEXT,            -- 'dry' | 'apply'
  started_at TEXT,
  finished_at TEXT,
  summary    TEXT             -- JSON: counts of add/remove/conflict/unmatched
);

CREATE TABLE actions (
  run_id       TEXT,
  pair_id      TEXT,
  identity_key TEXT,
  action       TEXT,          -- add_to_apple | add_to_spotify | remove_* | flag_conflict | unmatched
  status       TEXT,          -- planned | applied | skipped | reported | failed
  detail       TEXT
);
```

The ledger is the source of truth for resumability and idempotency — not the live services.
Before creating any Apple library playlist, check the ledger and the live library for an existing
one with the same mapped name to avoid duplicates.

---

## 10. Configuration (`sync.config.json`, git-tracked; secrets stay in `.env`)

```json
{
  "pairs": [
    {
      "id": "workout",
      "name": "Workout",
      "spotify_playlist": "spotify:playlist:XXXXXXXXXXXXXXXXXXXXXX",
      "apple_playlist": "AUTO_CREATE",
      "direction": "both"
    },
    {
      "id": "liked",
      "name": "Liked ⇆ Favorites",
      "spotify_playlist": "liked",
      "apple_playlist": "favorites",
      "direction": "both"
    }
  ],
  "match": { "search_accept_threshold": 70, "duration_tolerance_ms": 3000 }
}
```

`apple_playlist: "AUTO_CREATE"` tells the tool to create the Apple library playlist on first sync
and record its id in the ledger. Ship a `sync.config.example.json` with fake ids.

---

## 11. CLI surface

```
init                         # scaffold config from example, run db migrations
auth spotify                 # PKCE consent flow            (⏸ B)
auth apple                   # dev token + MUT capture      (⏸ D)
auth status                  # token validity / expiry, no secret values printed
doctor                       # env present? tokens valid? storefront? Apple delete-probe?
plan <pairId|all>            # dry-run: compute + write reports, NO writes
sync <pairId|all> [flags]    # execute
report                       # print last run summary from the ledger
```

`sync` flags:

- `--apply` — actually write (default is dry-run even for `sync`).
- `--direction both|s2a|a2s` — override the pair's configured direction for this run.
- `--allow-removals` — enable opt-in removal propagation (still capability-gated + confirmed).

Removals require BOTH `--apply` and `--allow-removals`, and trigger a confirmation pause showing
exactly what will be removed before anything is deleted.

---

## 12. Reliability, privacy, durability requirements

- **Rate limits / backoff:** wrap all HTTP in `util/http.ts` with exponential backoff + jitter on
  429/5xx, honoring `Retry-After`. Single worker, modest concurrency cap. A sync is not
  latency-sensitive; completeness beats speed.
- **Idempotency:** re-running `sync --apply` with no upstream changes must produce zero writes and
  an empty action set. Verify this explicitly in Phase 6 acceptance.
- **Resumability:** crash mid-run → restart skips work already recorded in the ledger.
- **No secret leakage:** `util/log.ts` must redact tokens, keys, and auth headers. Never log a
  full request with `Authorization` / `Music-User-Token`. Never echo secrets to chat.
- **No personal data in git:** `reports/` and `data/` are gitignored; they contain playlist
  contents and tokens.
- **Token storage:** `data/tokens.json`, gitignored, restrictive file permissions (0600 where the
  OS supports it).

### 12.5 Self-healing (runtime)

The tool must keep itself working as the world drifts, without a human babysitting it:

- **Schema migrations.** The ledger carries a `schema_version`; on startup, migrate forward
  automatically. Never make the human hand-edit the database. Adding columns/tables later is
  expected — that's the implementation tier evolving (§0).
- **Capability re-probing.** Re-run the Apple delete-probe (and any other gated capability) before
  acting on it, and on a sensible cadence via `doctor`. If a capability that previously passed now
  fails, fall back to report-only and warn — never assume yesterday's probe still holds.
- **Token healing.** Auto-refresh the Spotify token and auto-regenerate the Apple developer token
  near expiry. When the MUT cannot be refreshed, fail with a clear "run `auth apple`" message, not
  a raw 401.
- **Endpoint-drift detection.** If a known endpoint starts failing in a way that suggests it
  changed (persistent 4xx on a call that should succeed), surface it loudly and — for the volatile
  routes in §6 — re-verify before continuing. Never let drift silently corrupt the baseline.
- **Match revalidation.** Provide `--rematch` to invalidate cached mappings and re-resolve (e.g.
  when a catalog's canonical id changes). A stale mapping whose target id now 404s should be
  detected and re-resolved automatically.
- **Graceful degradation.** A single failed track add/remove is recorded as a `failed` action and
  retried next run; it never aborts the whole sync. Partial progress is always persisted.

---

## 13. Build phases & acceptance criteria (execute in order)

Each phase ends with a commit (see `CLAUDE.md` git workflow) and a `PROGRESS.md` entry.

- **Phase 0 — Scaffold.** Repo, `git init`, `.gitignore` (✅ before any other file), `package.json`,
  `tsconfig`, ESLint/Prettier, `.env.example`, `sync.config.example.json`, README skeleton,
  `PROGRESS.md`. **AC:** `npm run build` passes; `git status` shows no secret/data/report paths
  trackable.
- **Phase 1 — Config + ledger.** `config.ts`, `ledger/db.ts`, `init` command. **AC:** `init`
  creates `data/sync.sqlite` with the schema and a config from the example.
- **Phase 2 — Spotify auth + read.** PKCE flow, refresh, read client. **AC:** after ⏸A/⏸B, can
  list playlists, read a playlist's tracks with ISRCs, and read Liked Songs.
- **Phase 3 — Apple auth + read.** Dev-token signing, MUT capture page, read client. **AC:** after
  ⏸C/⏸D, `doctor` resolves storefront, reads library playlists, searches the catalog, and does an
  ISRC lookup. The Apple **delete-capability probe** runs here and records its result.
- **Phase 4 — Matching.** `identity`, `scoring`, `matcher` for both directions. **AC:** a known
  explicit Spotify track resolves to the explicit Apple master via ISRC (not the clean version);
  a no-ISRC track resolves via scored search or lands in unmatched; symmetric Apple→Spotify works.
- **Phase 5 — Plan / dry-run.** `engine`, `planner`, `reports`, `plan` command. **AC:** `plan` on a
  pair writes a correct add/remove/conflict/unmatched plan and reports, performs **zero** writes.
- **Phase 6 — Apply.** `applier`, idempotent additive sync, removal gating + confirmation. **AC:**
  `sync --apply` converges both sides on additions; a second run is a no-op; removals are
  report-only by default and only apply with `--allow-removals` + passed probe + confirmation.
- **Phase 7 — UX polish.** `auth status`, `report`, `doctor` completeness, logging redaction,
  helpful errors at every pause point. **AC:** all CLI commands documented and working.
- **Phase 8 — Publish prep.** Final secrets audit, README setup walkthrough, license. **AC:** clean
  repo, no secrets/data tracked. **⏸ PAUSE POINT E (optional):** ask the human before creating or
  pushing to a GitHub remote; do not create the remote autonomously.

---

## 14. Definition of done

- All eight phases pass their acceptance criteria.
- `plan` and `sync --apply` work for at least one real playlist pair **and** the Liked⇆Favorites
  pair, verified by the human.
- Re-running `sync --apply` with no changes writes nothing (idempotent).
- `doctor` reports green on env, both token sets, storefront, and records the Apple delete-probe
  result.
- README explains setup (incl. the four credential pause points) and states the removal asymmetry
  honestly.
- A secrets audit confirms the public repo is clean: no `.p8`, no `.env`, no tokens, no `reports/`,
  no `data/`.

---

## 15. Amendment log

This blueprint is a living document (§0). Whenever you change anything in the **implementation**
tier, append a row here. Leave the **invariants** tier untouched unless the human explicitly amends
it — and if they do, record that too, attributed to the human.

| Date   | Section(s) | Change                     | Rationale      | Invariants confirmed intact |
| ------ | ---------- | -------------------------- | -------------- | --------------------------- |
| _seed_ | —          | Initial blueprint authored | Starting point | n/a                         |

> Keep entries terse — one line each. The point is a traceable history of _why the design is what it
> is now_, so a future you (or a future agent) can tell deliberate evolution apart from drift.

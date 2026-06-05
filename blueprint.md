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
├─ data/                        # GITIGNORED: ledger.sqlite, tokens.json
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
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/auth/spotify/callback
APPLE_TEAM_ID=
APPLE_KEY_ID=
APPLE_PRIVATE_KEY_PATH=secrets/AuthKey_XXXXXXXXXX.p8
APPLE_MUSICKIT_APP_NAME=music-transfer-self-serve
```

The redirect URI **MUST** match byte-for-byte between four places:
`.env`, the Spotify Developer Dashboard app settings,
the `/api/auth/spotify/start` server code that builds the authorize URL,
and the `/auth/spotify/callback` route the server serves.
Spotify rejects any mismatch with `INVALID_REDIRECT_URI`.
Phase 2 acceptance includes a literal-string-equality check across these sources.

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

### 6.6 Verified write endpoints (live-checked 2026-06-04, before Phase 7)

Per the prime directive (verify the volatile bits), the WRITE endpoints were confirmed
against current official docs before wiring the Operation runner. Two findings changed
the implementation from the older priors above:

**Spotify — the Feb-2026 migration renamed every write/idempotency route** (not just the
read `/tracks`→`/items` rename found in Phase 2). For a Development-Mode app (which this
is — the old read `/tracks` already 403s for us), use the NEW routes:

| Operation        | Verified route                                  | Body / query                              | Cap |
| ---------------- | ----------------------------------------------- | ----------------------------------------- | --- |
| Add to playlist  | `POST /v1/playlists/{id}/items`                 | `{ uris: ["spotify:track:ID", …], position? }` | 100 |
| Save / Like      | `PUT /v1/me/library`                            | `{ uris: ["spotify:track:ID", …] }` (NOT `ids`) | 40 |
| Create playlist  | `POST /v1/me/playlists`                         | `{ name, public?, description? }` → returns `id` | 1 |
| Saved-contains   | `GET /v1/me/library/contains?uris=…`            | comma-sep URIs (NOT `ids`)                | 40 |

The silent-bug risk is the save/contains side switching `ids`→`uris` and 50→40. Each
write route is probed with one track before any bulk run.

**Apple — the favorites route exists and is unambiguous** (resolves the §6.3 "shifted
endpoint" concern in our favour, so an Apple-Favorites destination is a real write, not
report-only):

| Operation                 | Verified route                                  | Body / notes                               |
| ------------------------- | ----------------------------------------------- | ------------------------------------------ |
| Add to library playlist   | `POST /v1/me/library/playlists/{id}/tracks`     | FLAT `{ data:[{ id:<catalogSongId>, type:"songs" }] }`; catalog ids OK; 204; append-only |
| Create library playlist   | `POST /v1/me/library/playlists`                 | `{ attributes:{ name, description }, relationships?:{ tracks } }` → returns `p.XXXX`; can create empty then add |
| Favorite a song           | `POST /v1/me/favorites?ids=<catalogSongId>`     | 202, no body; **one-way — no un-favorite** (fits additive-only) |
| Read playlist tracks      | `GET /v1/me/library/playlists/{id}/tracks`      | `limit` max 100 → paginate; `?include=catalog` surfaces ISRC/catalog id |

**Apple hazard (verified live 2026-06-04): an EMPTY playlist 404s on its `/tracks`
relationship.** `GET /v1/me/library/playlists/{id}/tracks` for a playlist with zero tracks
returns **HTTP 404** with `errors[0].code == "40403"` / title `"No related resources"` —
NOT an empty `{ data: [] }`. This is the relationship-has-no-members signal, distinct from a
missing-playlist 404 (`code "40400"` / `"Resource Not Found"`). `listLibraryPlaylistTracks`
absorbs ONLY the `40403`/"No related resources" shape as `[]` (an empty destination ⇒ empty
skip-set ⇒ all matched tracks are added, which is correct and additive-safe); a `40400`
still propagates so a typo'd id can't masquerade as empty. Discovered when a real
Spotify→Apple run into a freshly-created empty "Sweat" playlist aborted at destination-read.

Apple documents no max batch for add-tracks → use a conservative sequential batch (100).
Apple writes may lag reads (eventual consistency) — handled by the §12.5 resume-soundness
union. The favorites doc doesn't enumerate accepted resource types → confirm `type:songs`
acceptance with one live probe before bulk (a runtime verification, not an assumption).

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
       (remix, live, sped up, slowed, remaster, remastered, instrumental, edit,
        karaoke, cover, acoustic, demo)
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
  platform     TEXT NOT NULL,      -- 'spotify' | 'apple'
  kind         TEXT NOT NULL,      -- 'playlist' | 'liked' | 'favorites'
  external_id  TEXT NOT NULL,      -- platform id; for liked/favorites singletons
                                   -- use sentinel '__liked__' or '__favorites__'
                                   -- (NEVER empty string or NULL — both break the PK)
  name         TEXT,
  owner        TEXT,               -- spotify owner / apple curator (nullable)
  track_count  INTEGER,
  url          TEXT,               -- deep link (nullable)
  fetched_at   TEXT,
  PRIMARY KEY (platform, kind, external_id)
);

-- one row per Permissions preflight run (UI button or CLI `doctor`)
CREATE TABLE preflight_runs (
  id          TEXT PRIMARY KEY,   -- ulid/uuid
  started_at  TEXT NOT NULL,
  finished_at TEXT,                -- nullable while running
  status      TEXT NOT NULL,       -- 'running' | 'passed' | 'failed' | 'partial' | 'invalidated' | 'interrupted'
                                   -- ('interrupted' = startup sweep found this row stuck
                                   --  in 'running' after a crash; §12.5, same as operations)
  trigger     TEXT NOT NULL,       -- 'manual' | 'cli' | 'auto-401' | 'auto-403-scope'
  surface     TEXT NOT NULL        -- 'ui' | 'cli'
);

-- at most ONE preflight may be 'running' at a time; enforced by partial unique index
CREATE UNIQUE INDEX one_running_preflight ON preflight_runs(status)
  WHERE status = 'running';

-- per-check result row, ordered by seq within a preflight run
CREATE TABLE preflight_checks (
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,        -- v1: 'env' | 'spotify_token' | 'spotify_scopes' |
                                    -- 'spotify_me' | 'spotify_search' | 'apple_dev_token' |
                                    -- 'apple_mut' | 'apple_storefront' |
                                    -- 'apple_library_read' | 'apple_isrc_lookup'
                                    -- ('apple_delete_probe' returns if removals do; §6.2)
  status      TEXT NOT NULL,        -- 'pass' | 'fail' | 'skip'   ('warn' was dropped 2026-06-03)
  detail      TEXT,                 -- JSON; MUST conform to the per-check allow-list (§12)
  duration_ms INTEGER,
  PRIMARY KEY (run_id, seq)
);

-- one row per Operation the human has run (or started running)
CREATE TABLE operations (
  id                 TEXT PRIMARY KEY,  -- ulid/uuid
  created_at         TEXT NOT NULL,
  finished_at        TEXT,              -- nullable while running
  source             TEXT NOT NULL,     -- 'spotify' | 'apple'
  destination        TEXT NOT NULL,     -- 'spotify' | 'apple'
  source_target      TEXT NOT NULL,     -- JSON { kind: 'playlist'|'liked'|'favorites', id?, name?, url? }
  destination_target TEXT NOT NULL,     -- JSON same shape
  status             TEXT NOT NULL,     -- 'queued' | 'running' | 'succeeded' | 'partial' |
                                        -- 'failed' | 'interrupted'  ('interrupted' = startup
                                        --  reconciliation found this row stuck in 'running'
                                        --  after a server crash; see §12.5)
  summary            TEXT               -- JSON counts: read, matched, skipped, written, unmatched, failed
);

-- at most ONE Operation may be 'running' at a time; enforced by partial unique index
-- (in addition to the in-process serialization in §11.2 / §8)
CREATE UNIQUE INDEX one_running_op ON operations(status) WHERE status = 'running';

-- recency lookups for the gating policy (§11.1) — "latest passed preflight within last 24h"
CREATE INDEX preflight_runs_finished ON preflight_runs(finished_at DESC);
CREATE INDEX operations_finished ON operations(finished_at DESC);

-- append-only, ordered event log per Operation; backs SSE live + replay
CREATE TABLE operation_events (
  operation_id TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,        -- 'stage' | 'match' | 'skip' | 'write' | 'unmatched' |
                                     -- 'error' | 'done' | 'interrupted'
  payload      TEXT,                 -- JSON
  PRIMARY KEY (operation_id, seq)
);
```

The ledger is the source of truth for resumability, idempotency, and the SSE event-log
replay — not the live services.

**SQLite configuration (db.ts on open):**
- `PRAGMA journal_mode = WAL;` — readers don't block writers; required because the HTTP
  server's request handlers and the Operation runner both touch the DB concurrently.
- `PRAGMA foreign_keys = ON;` — even though the schema above doesn't declare FKs explicitly
  in v1, future amendments may, and this is a one-line forward investment.
- `PRAGMA synchronous = NORMAL;` — paired with WAL, durable enough for a single-user local
  tool; faster than `FULL`.

**Schema-version semantics (consumed by `ledger/db.ts` on startup):**
- A fresh DB starts at version 0 (no row). `db.ts` runs migrations in order from
  `current_version + 1` up to `LATEST_VERSION`, each in its own transaction, and each
  migration ends by `INSERT OR REPLACE INTO schema_version VALUES (N)`.
- v1 ships with `LATEST_VERSION = 1` (this schema). The first run on a fresh DB applies
  migration #1 which creates all tables + indexes above.
- Migrations are forward-only. Never write a down-migration; the cost of forgetting and
  running one in production is too high for a single-user tool with no test DB.

**Disambiguation rules** (referenced from §8 step 2 and §11.1):

Before creating a new playlist on the destination side (free-text name case), normalize the
typed name (trim + collapse internal whitespace + case-fold) and search the catalog cache
**and** the live library for matches by normalized name. Then:
- **0 matches** — create the new playlist (destination side only; on the source side, the
  Operation fails with a clear error since you can't transfer from a playlist that doesn't
  exist).
- **1 match** — auto-resolve to that playlist. Record the resolution in the Operation's
  event log so the user can confirm in the Run panel.
- **≥2 matches** — server returns `422 Unprocessable Entity` with the candidate list
  (id, name, owner, track_count, url) on the relevant side. The UI shows a disambiguation
  modal and the user picks one (or, on the destination side, chooses "create new with this
  name anyway"). The re-submitted POST includes the resolved `id`, bypassing the name
  lookup.

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

### 11.0 Local-server security model (read this before reading 11.1–11.3)

The local Node HTTP server is a unique trust environment.
It serves the UI to the user's own browser — but **any** page in any tab of that same
browser can, in principle, issue HTTP requests to `127.0.0.1:8888`.
The browser same-origin policy blocks cross-origin **reads** of responses;
it does **not** block cross-origin **sends** (a malicious page can POST to our endpoints
and we'd execute the action even if the attacker never sees the response).

§11 was originally written as if a local server were trust-equivalent to a CLI process.
It isn't. The defenses below are required — every route in §11.2 must obey them,
and Phases 1, 2, and 3 must implement the corresponding pieces.

**Network surface.**

- The server **MUST** bind to `127.0.0.1` only (`server.listen(8888, '127.0.0.1', ...)`),
  never `0.0.0.0` or unspecified.
  This prevents the server from ever being reachable from the network — only from the
  same host.
- Fixed port `8888` (matches the redirect URI in §4).
  If the port is taken, fail with a clear error; do not silently fall back.

**Origin and Host header validation.**

Every state-changing route (any `POST` in §11.2, plus the two OAuth callbacks
`/auth/spotify/callback` and `/api/auth/apple/callback`) **MUST** reject the request
with `403 Forbidden` if **any** of these fail:

- `Host` header is not exactly `127.0.0.1:8888`.
- `Origin` header is missing on a `POST`. (Modern browsers always send `Origin` on
  cross-origin POSTs; missing-on-POST signals a non-browser client we don't serve.)
- `Origin` header is present and is not exactly `http://127.0.0.1:8888`.
- The Spotify callback (`GET /auth/spotify/callback`) is exempt from the `Origin` check
  (Spotify's redirect is a top-level navigation, no Origin) but **must** validate the
  `state` parameter (below).
- The Apple callback (`POST /api/auth/apple/callback`) gets the full Origin + nonce check.

GET routes that only return data (e.g. `/api/health`, `/api/preflight/latest`,
`/api/catalog`) do not require Origin checks since cross-origin reads are blocked by
the browser; but they **must** still validate `Host` to prevent DNS-rebinding attacks
that resolve a public hostname to 127.0.0.1.

**CSRF token (per-server-start, browser-served).**

At server startup, generate a CSRF token: 32 random bytes from `crypto.randomBytes(32)`,
base64url-encoded.
Embed it in the served HTML as `<meta name="csrf-token" content="...">`.
The UI's `app.js` reads it at load and includes it on every state-changing request as
the header `X-CSRF-Token`.
Every `POST` route **MUST** reject the request with `403 Forbidden` if the header is
absent or does not match the server-start token.
The token rotates on every server restart; the UI re-reads it on every full page load.
SSE GET endpoints do not require the CSRF header (idempotent reads), but they DO require
the `Host` check.

**OAuth `state` + PKCE `code_verifier` server-side store.**

`POST /api/auth/spotify/start` performs:
1. Generate `state` — 32 random bytes, base64url-encoded.
2. Generate `code_verifier` per RFC 7636 (43–128 chars, base64url alphabet).
3. Derive `code_challenge = base64url(SHA256(code_verifier))`.
4. Store `{ state → { code_verifier, created_at } }` in an in-memory `Map`.
5. Return `{ authorizeUrl }` with `state`, `code_challenge`, `code_challenge_method=S256`,
   and the exact `redirect_uri` from §4 embedded.

`GET /auth/spotify/callback` performs:
1. Extract `state` and `code` from the query string.
2. Look up `state` in the in-memory map.
   If missing → `403 Forbidden` (state forged or expired).
   If `Date.now() - created_at > 10 * 60 * 1000` → `403` (expired) and delete the entry.
3. Retrieve the `code_verifier`; exchange `code` + `code_verifier` for tokens at Spotify.
4. Persist tokens + granted `scope` to `data/tokens.json` (§5.1).
5. **Delete** the state entry (one-time use).
6. Serve a tiny HTML page that calls `window.close()` (popup auto-close); the UI's main
   window detects the auth-status flip by polling `/api/auth/status` on focus.

Sweep the in-memory state map every 60s to drop entries older than 10 minutes.

**Apple popup nonce.**

`POST /api/auth/apple/start` performs:
1. Generate `nonce` — 32 random bytes, base64url.
2. Mint a **short-lived** developer token: ES256-signed JWT with `exp = now + 600s`
   (10 minutes), same `iss` (Team ID) and `kid` (Key ID) as the long-lived token,
   signed with the same `.p8`. **This** is the token returned to the browser — never
   the 180-day token.
3. Store `{ nonce → { created_at } }` in an in-memory `Map`.
4. Return `{ developerToken, nonce }` to the popup.

The popup HTML (`web/musickit.html`) loads MusicKit JS, configures it with the
short-lived developer token, calls `authorize()`, then POSTs to
`/api/auth/apple/callback` with `{ nonce, mut }` (plus CSRF + Origin per the above).

`POST /api/auth/apple/callback` performs:
1. Validate Origin + Host + CSRF.
2. Look up `nonce`. Missing or older than 10 min → `403`.
3. Persist the MUT to `data/tokens.json`.
4. **Delete** the nonce entry.
5. Return a small HTML that calls `window.close()`.

Sweep nonces on the same 60s cadence.

**Long-lived secrets stay server-side.**

The 180-day Apple developer-token JWT and the `.p8` private key **never** appear in
any browser-facing response, any HTML the server serves, any URL query string, any log
line, or any error body.
The browser only ever sees the 10-minute popup token (above).
All Apple **server-to-Apple** calls use the long-lived JWT.

**No cookies, no session storage.**

The CSRF token in HTML is the only browser-visible server-generated value.
The server **MUST NOT** set any cookies; `util/log.ts` redacts `Set-Cookie` defensively
in case a dependency does.

**Phase acceptance.**

Phase 1 implements the network bind, Origin/Host middleware, and CSRF token
generation + injection + verification framework (validating against `/api/health` is
trivial — make the framework first).
Phase 2 implements the OAuth state + PKCE store + sweep.
Phase 3 implements the popup nonce + short-lived dev token + sweep.
Each of these gets a Phase AC subcriterion in §13.

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
       **Fixture sourcing**: fetch one song from the resolved storefront's top chart
       (`GET /v1/catalog/{storefront}/charts?types=songs&limit=1`),
       extract its `attributes.isrc`, then run the lookup against that ISRC.
       This avoids hardcoded fixtures that drift across storefronts and over time, and
       proves the chart endpoint works as a side-benefit.
       If the chart returns no songs or the top song has no ISRC, the check is `skip`
       with detail explaining why (rare; recover by retrying or by manually re-Connecting
       Apple Music).

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

   **Mid-Operation gate invalidation behavior.**
   If a downstream call inside a running Operation triggers an invalidation,
   the **current** Operation continues to completion (it already passed the gate at
   POST time, and each remaining write will independently refresh+retry on its own 401).
   The invalidation only prevents the **next** action (catalog refresh or new Operation).
   This avoids aborting a partially-written transfer over a transient credential blip.

   **UI gate-state refresh.**
   The UI polls `GET /api/preflight/latest` on these triggers:
   (a) every full page load,
   (b) on `window.focus` (covers "user opens UI the next day"),
   (c) after any 412 response is observed,
   (d) after the **Check permissions** SSE stream ends.
   This is the mechanism by which a `doctor` (CLI) pass becomes visible to the UI.

3. **Catalog panel.**
   An **Update Catalog** button fetches the user's playlists from each connected platform
   and stores them in the `catalog` table;
   live progress streams via SSE from `/api/catalog/events`.
   After a refresh, the Operation form's dropdowns repopulate.
   The panel also shows when each platform's catalog was last fetched.
   This panel is disabled when the preflight gate has not passed.
   The refresh is incremental (one platform at a time, then playlist-by-playlist within
   each); the panel shows a per-platform progress bar and is cancellable via a
   `POST /api/catalog/refresh/cancel` endpoint (which deletes any in-flight refresh state
   but **keeps** any catalog rows already written).
4. **Operation form.** Fields:
   - `Source` — radio (Spotify / Apple)
   - `Destination` — radio (Spotify / Apple), auto-filtered so it cannot equal `Source`.
     "Auto-filtered" means: when the user picks a Source, the matching Destination radio
     becomes disabled and, if it was previously selected, flips to the other platform.
     Liked/Favorites selections reset whenever Source or Destination changes (since
     they're platform-scoped).
   - `Source Target` — a dropdown of the source's cached playlists
     (with the platform's Liked/Favorites pinned at the top),
     **plus** a free-text input for a playlist id / URL / name.
     The dropdown and the input are mutually exclusive;
     selecting Liked/Favorites disables the input.
   - `Destination Target` — same shape, on the destination side.
     The free-text input here accepts an existing playlist (id / URL / name) **or** a new
     name to be created.
     Selecting Favorites/Liked disables the input.
     When the input contains a free-text **name** (not id or URL), resolution happens
     server-side at submit per the §9 disambiguation rules (0/1/≥2 matches).
     A `422` response with a candidate list pops a disambiguation modal; the user picks
     an existing playlist (or, on the destination side, "Create new with this name").
   - **Advanced** (disclosure, collapsed by default):
     - `Rematch` — checkbox, default off.
       When on, the Operation invalidates and recomputes any cached `tracks` rows for
       source items (per §12.5), instead of using cached matches.
       Useful when a platform's catalog has shifted underneath us.
   - **Run** — submits the Operation.
     Disabled when **preflight has not passed**, when source ≡ destination, when either
     side is unauthorized, when both target fields on a side are empty, or when an
     Operation is already running.
     A disabled Run button shows its block reason on hover.
5. **Run panel.**
   When an Operation is running or has just finished, this panel shows:
   current stage (resolving source → reading destination → matching → writing → done),
   a progress bar (written / matched out of total),
   a scrollable event log, and a final summary card with counts and a copyable JSON
   summary.

   **Event-log rendering.**
   The log can grow to thousands of lines on a 5000-track Operation.
   The UI keeps an in-memory aggregate counter (matched / skipped / written / unmatched /
   failed) and renders only the **last 500** events in the scrollable view; older events
   are summarized as "+N earlier events — Download full log" which fetches the complete
   list via `GET /api/operations/:id` (the server returns it from `operation_events`).
   This keeps the DOM bounded.

   **"Past operations" disclosure** lists prior operations from the ledger with
   timestamp, source/destination summary, status, and a click-through to that
   operation's full event log (via `/api/operations/:id/events`, which replays from the
   ledger).
   Interrupted operations (status `interrupted`, set by the startup sweep per §12.5)
   are shown with a hint: "Run the same Operation again — already-written items will be
   skipped automatically."

   **Popup OAuth failure handling.**
   The auth panel tracks the popup window reference after opening it.
   If the popup is blocked at open → show "Your browser blocked the popup; allow popups
   for 127.0.0.1:8888 and try again."
   If the popup closes without a callback being recorded → after a 10s grace period the
   UI clears the in-progress state and re-enables the Connect button with
   "Connect attempt did not complete; try again."
   The server-side `state`/nonce store entry expires on its own 10-minute TTL.

### 11.2 HTTP API (consumed by the UI; documented for diagnostics)

All POSTs require `X-CSRF-Token` (matches the server-start token in `<meta name="csrf-token">`)
and a same-origin `Origin: http://127.0.0.1:8888` header per §11.0.
Missing/wrong CSRF or Origin → `403`.

```
GET    /api/health                  liveness
GET    /api/auth/status             { spotify: {connected, expiresAt?, scope?},
                                      apple:   {connected, expiresAt?, storefront?} }
POST   /api/auth/spotify/start      returns { authorizeUrl } the UI opens in a popup
                                    (server generates+stores state+code_verifier per §11.0)
GET    /auth/spotify/callback       Spotify redirects here; server validates state; stores
                                    tokens + scope; serves auto-close HTML
POST   /api/auth/apple/start        returns { developerToken, nonce }; developerToken is the
                                    short-lived (10min) JWT per §11.0; nonce binds /start to
                                    /callback
POST   /api/auth/apple/callback     body: { nonce, mut }; validates nonce; stores MUT;
                                    serves auto-close HTML
GET    /api/preflight/latest        latest preflight_runs row + its checks; null if none
POST   /api/preflight/run           starts a new preflight; returns { id }; 409 if one is running
GET    /api/preflight/:id           a specific preflight_runs row + its checks
GET    /api/preflight/:id/events    SSE: per-check live events (and replay from the ledger);
                                    supports `Last-Event-ID` header (= last seen seq) for
                                    reconnects — server replays events with seq > last-seen
GET    /api/catalog                 current cached catalog, both platforms
POST   /api/catalog/refresh         kicks off an incremental refresh of both connected platforms;
                                    returns 412 if preflight gate has not passed
POST   /api/catalog/refresh/cancel  cancels an in-flight refresh; already-fetched rows kept
GET    /api/catalog/events          SSE: refresh progress; per-platform per-playlist events
POST   /api/operations              body: { source, destination, sourceTarget, destinationTarget,
                                              rematch?: boolean }
                                    returns { id } on 201;
                                    409 if another Operation is running;
                                    412 if preflight gate has not passed;
                                    422 with { side, candidates: [...] } if a free-text target
                                        name matches ≥2 existing playlists (see §9
                                        disambiguation rules); resubmit with the chosen
                                        playlist id in sourceTarget/destinationTarget
GET    /api/operations              recent operations list (from ledger)
GET    /api/operations/:id          operation record + summary (with full event log)
GET    /api/operations/:id/events   SSE: live events (and replay from the ledger on reconnect);
                                    supports `Last-Event-ID` (= last seen `operation_events.seq`)
                                    — on reconnect, server emits all events with seq >
                                    last-seen, then continues live
```

**SSE conventions** (apply to all SSE endpoints above):

- `Content-Type: text/event-stream`; `Cache-Control: no-cache`; `Connection: keep-alive`.
- Each event:
  ```
  id: <numeric seq>
  event: <type>
  data: <single-line JSON>
  ```
  The `id:` line is the row's `seq` from the relevant `_events` table, enabling the
  standard `Last-Event-ID` resumption protocol the browser EventSource implements.
- Server keeps the stream open until the run is `done` (final event with `type: 'done'`
  for operations, or `type: 'complete'` for preflight/catalog refresh), then closes.
- On reconnect (browser auto-reconnects EventSource), the server checks `Last-Event-ID`
  and replays from there; if the run has finished, all remaining events are replayed and
  the stream is closed cleanly.

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
- **No secret leakage.**
  `util/log.ts` MUST redact, in this order, before any string reaches stdout, stderr, a
  file, an HTTP response, or an SSE payload:
  - Request/response **headers**: `Authorization`, `Music-User-Token`, `Set-Cookie`,
    `Cookie`, `X-Apple-Music-User-Token`.
  - Request/response **body** fields (case-insensitive JSON key match):
    `access_token`, `refresh_token`, `developerToken`, `developer_token`,
    `musicUserToken`, `music_user_token`, `id_token`, `code_verifier`, `state`, `nonce`,
    `code` (when appearing in an OAuth context — practical heuristic: any URL containing
    `/oauth/` or `/auth/` or a body matching the token-exchange shape).
  - Query-string parameters with any of the names above.
  - Any string that **looks** like `Bearer <40+chars>` regardless of context.
  - Any string matching `-----BEGIN .* PRIVATE KEY-----`.
  - The configured `APPLE_TEAM_ID` and `APPLE_KEY_ID` values (loaded once from env at
    log-module init).
  Redaction substitutes `<redacted:<kind>>`. Test fixtures live in `util/log.test.ts`.
- **Preflight `detail` JSON allow-lists.**
  Each preflight check has a fixed schema for its `detail` column — implementer ships
  these as constants in `preflight/checks.ts`. The runner enforces "no extra fields"
  before insert. Allow-lists for v1:
  ```
  env               → { missing_keys: string[], key_file_readable: boolean }
  spotify_token     → { source: 'fresh'|'refreshed', expires_in_seconds: number }
  spotify_scopes    → { missing_scopes: string[], granted_count: number }
  spotify_me        → { user_id_hash: string }                    -- SHA256(user.id)[0:12]
  spotify_search    → { results_returned: number }
  apple_dev_token   → { alg: 'ES256', exp_days_remaining: number, signed: boolean }
                                                                  -- never iss/kid (=Team/Key ID)
  apple_mut         → { accepted: boolean }
  apple_storefront  → { storefront: string }                      -- e.g. 'us'
  apple_library_read → { playlists_returned: number }
  apple_isrc_lookup → { fixture_isrc: string, validated_candidates: number }
                                                                  -- ISRC is public
  ```
  `failure` rows additionally carry `{ error_class, error_message_safe }` where
  `error_message_safe` is the platform's error message **after** redaction.
- **No personal data in git:** `data/` is gitignored;
  it contains playlist contents, tokens, and the per-Operation event log.
- **File permissions.** Created with restrictive modes at first write; verified at server
  startup (warn-and-fix if drifted):
  - `data/tokens.json` → `0600`.
  - `data/ledger.sqlite`, `data/ledger.sqlite-wal`, `data/ledger.sqlite-shm` → `0600`.
  - `secrets/AuthKey_*.p8` → `0600`. (Apple's downloaded `.p8` is `0644` by default;
    `chmod 0600` it on first read, or refuse to run if it's group/world readable.)
  - `data/` and `secrets/` directories → `0700`.
  (POSIX only. On Windows these are no-ops; document the limitation in the README.)

### 12.5 Self-healing (runtime)

The tool must keep itself working as the world drifts, without a human babysitting it:

- **Schema migrations.**
  The ledger carries a `schema_version`; on startup, migrate forward automatically per the
  semantics in §9 ("Schema-version semantics").
  Never make the human hand-edit the database.
  Adding columns/tables later is expected — that's the implementation tier evolving (§0).
- **Startup reconciliation sweep.**
  On server start, `db.ts` runs a transaction that:
  - For every `operations` row with `status='running' AND finished_at IS NULL`:
    mark `status='interrupted'`, set `finished_at = now()`, and append a final event row
    `{ type: 'interrupted', payload: { reason: 'server_restart_during_run' } }`.
  - For every `preflight_runs` row with the same shape: mark `status='interrupted'`,
    set `finished_at = now()`.
  This guarantees the partial unique indexes (§9) never have a stranded "running" row
  blocking the next start, and the UI's Past-Operations list never shows perpetual
  "running" entries.
  Re-running an interrupted Operation **is** the resume mechanism: the new run's read of
  `D` reflects whatever was written before the crash, so already-written items naturally
  skip (§8 idempotency).
- **Resume soundness.**
  The destination read in §8 step 2 might lag behind very recent writes due to platform
  eventual consistency (Apple library reads can lag library writes by several seconds).
  To prevent duplicate appends after a crash-then-resume, the runner unions `D` with the
  set of `write`-type rows in `operation_events` from prior runs of the same
  `(source, destination, sourceTarget, destinationTarget)` tuple before computing the
  skip set. `operation_events` is the canonical record of what was definitely written.
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
  Two paths:
  - **User-triggered**: the Operation form's Advanced **Rematch** toggle (§11.1 panel 4) or
    `POST /api/operations` body field `rematch: true` (§11.2).
    When set, the runner **deletes** cached `tracks` rows whose `identity_key` matches the
    source items of this Operation before resolution, forcing live re-lookup for each.
    Useful when a platform's catalog has shifted underneath us.
  - **Auto**: when the runner attempts to write using a cached `apple_catalog_id` /
    `spotify_id` and the platform returns 404 (the cached id no longer exists), the runner
    invalidates that one `tracks` row and re-resolves that single item via the matcher
    (§7) before retrying the write. Logged as a `match` event with a `revalidated: true`
    marker so the human can see why a re-run wasn't a no-op.
- **Graceful degradation.**
  A single failed track add is recorded as a `failed` action and retried on the next run;
  it never aborts the whole Operation.
  Partial progress is always persisted.

---

## 13. Build phases & acceptance criteria (execute in order)

Each phase ends with a commit (see `CLAUDE.md` git workflow) and a `PROGRESS.md` entry.

- **Phase 0 — Scaffold.**
  Repo, `git init`, `.gitignore` (✅ before any other file),
  `package.json` (with `"build": "tsc --noEmit"` and `"start": "tsx src/server.ts"`),
  `tsconfig.json` (`strict: true`, `module: NodeNext`, `target: ES2022`, `lib: ['ES2023']`,
  `moduleResolution: NodeNext`, `noUncheckedIndexedAccess: true`),
  ESLint/Prettier configs (Prettier with `proseWrap: preserve` to match the existing
  `<!-- @format -->` directive in docs),
  `.env.example` (keys per §4), an empty `web/index.html` placeholder, README skeleton,
  and `PROGRESS.md`.
  **AC:** `npm install` then `npm run build` exits 0 against an empty `src/` tree
  (tsc on no input is a no-op);
  `git status` shows no secret/data paths trackable;
  the obsolete `sync.config.example.json` has been removed (per §10).
- **Phase 1 — Ledger + HTTP server skeleton + security framework.**
  `config.ts`, `ledger/db.ts` with the §9 schema + WAL/foreign-keys/synchronous PRAGMAs +
  forward-migration runner + startup reconciliation sweep (§12.5),
  `http/server.ts` serving `/api/health` and static `/web/` assets,
  `src/server.ts` entrypoint.
  Implement the §11.0 framework: bind to `127.0.0.1` only (fail loudly on bind error);
  middleware that enforces `Host` on all routes and `Origin` + `X-CSRF-Token` on POSTs;
  per-server-start CSRF token (32-byte base64url, embedded as `<meta>` in served HTML).
  **AC:**
  1. `npx tsx src/server.ts` starts; `data/ledger.sqlite` is created with all tables,
     all partial unique indexes, and `schema_version` row at version 1.
  2. `GET http://127.0.0.1:8888/api/health` from the served UI returns 200; the same
     request from `http://localhost:8888` returns 403 (Host mismatch — `localhost`
     ≠ `127.0.0.1`).
  3. `POST /api/health` (hypothetical for the test) without `X-CSRF-Token` returns 403;
     with the wrong token returns 403; with the served token returns the expected
     response.
  4. Restarting the server while a `running` row exists in `operations` or
     `preflight_runs` (manually seeded) results in those rows being marked `interrupted`
     with a final event row appended (§12.5).
- **Phase 2 — Spotify auth + read.**
  PKCE flow wired through the UI's auth panel; loopback callback served by the same HTTP
  server; refresh; read client (playlists, playlist tracks, Liked).
  Implement the §11.0 OAuth `state` + `code_verifier` server-side store (in-memory map,
  10-minute TTL, swept every 60s) and use it in `/api/auth/spotify/start` and
  `/auth/spotify/callback`.
  Persist the `scope` field returned at token exchange (and at each refresh) into
  `data/tokens.json` so `spotify_scopes` in Phase 5 has data to read.
  **AC:**
  1. After ⏸A/⏸B, the UI shows Spotify connected; the read client returns the user's
     Spotify playlists + Liked with ISRCs on a sample tracklist.
  2. `SPOTIFY_REDIRECT_URI` matches byte-for-byte across `.env`, `.env.example` (§4),
     `/api/auth/spotify/start` URL construction, and the `/auth/spotify/callback` route
     registration. Implementer asserts this via a unit test that compares the four
     strings.
  3. A callback with a `state` that's not in the in-memory store returns 403; a callback
     with an expired (>10min) state returns 403 and the entry is purged.
- **Phase 3 — Apple auth + read.**
  Dev-token signing, MusicKit page at `/auth/apple/musickit`, MUT capture POSTed back to
  the server; storefront resolution; read client (library playlists, Favorites, catalog
  search, ISRC lookup).
  Implement the §11.0 popup nonce store and the **short-lived (10-minute)** developer
  token minted just for the popup; the 180-day token stays server-side.
  **AC:**
  1. After ⏸C/⏸D, the UI shows Apple connected; storefront resolves and the read client
     returns library playlists + Favorites + a known ISRC lookup.
  2. The developer token in the popup HTML (inspectable via DevTools "View page source")
     decodes to a JWT with `exp` ≤ 10 minutes from now.
  3. A POST to `/api/auth/apple/callback` with a nonce that's not in the store, or older
     than 10 minutes, returns 403; nonces are consumed exactly once.
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
  `catalog/catalog.ts` + `/api/catalog/*` endpoints + SSE refresh stream
  (incremental, cancellable per §11.1);
  the UI's Operation form populates dropdowns from the cache,
  enforces source ≠ destination (auto-filter + reset of Liked/Favorites on change per
  §11.1),
  disables the free-text input when Liked/Favorites is selected,
  and surfaces the §9 disambiguation modal on the UI when the server returns 422.
  **AC:**
  1. Clicking **Update Catalog** refreshes both sides with live per-platform progress;
     the dropdowns populate from the catalog table.
  2. Clicking **Cancel** mid-refresh stops further fetches; already-stored catalog rows
     remain (no rollback).
  3. The Run button enables only when preflight has passed, both targets are resolved,
     and an Operation is not already running.
  4. A free-text destination name matching ≥2 existing playlists returns 422 with the
     candidate list; the UI shows a disambiguation modal; resubmitting with a chosen id
     succeeds.
- **Phase 7 — Operation runner + live status + rematch.**
  `operation/runner.ts` executes the additive transfer per §8,
  emits SSE events through `/api/operations/:id/events` with the `id:` (= `seq`)
  protocol from §11.2,
  persists the event log + summary to the ledger;
  the Run panel streams status with the §11.1 event-log virtualization.
  Implements the user-triggered **rematch** path from §12.5 (the form's Advanced toggle
  and the POST body's `rematch: true`).
  Implements the §12.5 resume-soundness union (read of `D` unioned with prior
  `operation_events.write` rows for the same Operation tuple).
  **AC:**
  1. An Operation moves missing tracks from S to D and skips items already in D.
  2. A second run of the same Operation writes zero (idempotent).
  3. A mid-run failure on a single track is recorded as a `failed` action; the Operation
     continues.
  4. Killing the server mid-Operation (and restarting) leaves the prior row at
     `status='interrupted'`; re-submitting the same Operation skips already-written items
     **even if the platform's destination read hasn't caught up yet** (resume union with
     `operation_events.write`).
  5. Setting `rematch: true` on an Operation whose source items already have cached
     `tracks` rows causes the runner to re-resolve them (verified by a `match` event with
     `from_cache: false` for items that previously had `from_cache: true`).
  6. Reconnecting to the SSE stream with `Last-Event-ID: N` replays only events with
     seq > N, then continues live.
  7. Auto-revalidation: when a write fails with 404 on a cached target id, the runner
     invalidates that one `tracks` row, re-resolves via §7, and retries; logged as a
     `match` event with `revalidated: true`.
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
- **§11.0 security model is in place**: server binds to 127.0.0.1 only;
  Origin/Host validation rejects cross-origin POSTs; CSRF token required and enforced
  on every POST; OAuth state + PKCE verifier stored server-side with 10-minute TTL;
  Apple popup uses a short-lived (≤10min) developer token bound by nonce; the 180-day
  Apple JWT never appears in any browser-facing response.
- The web UI can run, end-to-end, an Operation from a real Spotify playlist to a real
  Apple Music playlist **and** the symmetric Apple → Spotify direction, verified by the
  human.
  At least one of those Operations uses Liked/Favorites on one side.
- Re-running the same Operation with no source changes writes nothing (idempotent).
- Killing the server mid-Operation and restarting leaves no orphaned `status='running'`
  rows; the prior row is `interrupted`; re-submitting the same Operation completes the
  remaining work without duplicating already-written items.
- `doctor` (CLI) and the UI's Permissions panel agree —
  a `doctor` pass satisfies the UI's gate (visible to the UI within the polling cadence
  per §11.1), and a UI pass shows up in `doctor`'s history.
- README explains setup (incl. the four credential pause points + the preflight step),
  how to launch the UI, and the additive-only / no-removals posture honestly.
- A secrets audit confirms the public repo is clean:
  no `.p8`, no `.env`, no tokens, no `data/`, no `web/` assets containing personal data,
  no real `APPLE_TEAM_ID` / `APPLE_KEY_ID` in any tracked file.

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
| 2026-06-03 | §1, §6.2, §9, §11.1, §13, §14, §15                | **Preflight design tightened after a validation pass on five concerns**: (1) gate now requires latest `passed` AND `finished_at` within 24h (soft expiry catches overnight drift); (2) **`apple_delete_probe` removed from v1 preflight** — v1 deletes nothing, so the probe is deferred along with removals (§6.2 now states this explicitly); the check list is now 10, not 11. (3) Auto-invalidation is refresh-aware: `util/http.ts` attempts one token refresh / dev-token re-sign + retry; only the second 401, or a 403 whose body indicates a scope problem (not rate-limit), invalidates the gate (`trigger='auto-401'` or `'auto-403-scope'`). (4) `spotify_scopes` is implemented by reading the granted scope list **persisted in `data/tokens.json`** from the OAuth `scope` response field — Spotify has no public token-introspection endpoint for PKCE clients, and inventing one would violate the truthfulness invariant. (5) Ten checks remain fine-grained but are presented in three UI groups (Environment / Spotify / Apple), env-first, Spotify and Apple groups run in parallel, intra-group skips when a prerequisite fails. Phase 5 AC rewritten as six numbered subcriteria.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Human asked to deeply validate and resolve the five open concerns I raised against the previous amendment. Each resolution favors safety (fail-fast, no invented endpoints), accuracy (refresh-aware invalidation reduces false-positives), and clarity (grouped UI, scoped detail messages). | Non-destruction unchanged. Secrets/privacy unchanged (scope list persisted alongside refresh token in already-gitignored `data/tokens.json`). Truthfulness **strengthened**: scope-check implementation explicitly forbids inventing an introspection endpoint; delete-probe deferral removes a latent untested code path. Auditability unchanged. Scope unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-06-04 | §6.6 (new)                                        | **Verified the write endpoints live before Phase 7.** Spotify's Feb-2026 migration renamed all four write/idempotency routes (`/playlists/{id}/items`, `PUT /me/library`, `POST /me/playlists`, `/me/library/contains`), switched save/contains from `ids`→`uris`, and dropped those batch caps 50→40 — coding from the old priors would have silently failed. Apple's favorites route is confirmed (`POST /me/favorites?ids=`, one-way), so an Apple-Favorites destination is a real write, not report-only (resolves the §6.3 "shifted endpoint" concern). Add-tracks body is flat `{data:[{id,type:"songs"}]}` with catalog ids. | Prime directive: verify the volatile bits against live docs before wiring writes. The migration would have caused silent first-run write failures. | Non-destruction unchanged (still additive-only; Apple has no un-favorite API, Spotify removals remain out of v1 scope). Secrets/privacy unchanged. Truthfulness **strengthened** — endpoints confirmed against official docs, none invented; `type:songs` favorites acceptance to be runtime-probed. Auditability/scope unchanged. |
| 2026-06-04 | §7                                                | **Phase 4 validation: expanded the §7 variant-token list** from 9 to 12 tokens — added `remastered` (the past-tense form `remaster` missed), `acoustic`, and `demo`. These are real-world non-master variants the original list didn't catch; the implementation tier explicitly permits heuristic evolution (§0). The -25-per-token penalty mechanic, the +40/+30/+15/+10/+5 weights, and the 70 threshold are unchanged. | A 5-persona Phase 4 validation flagged the implementation's `VARIANT_TOKENS` (12 entries) drifting from the spec's 9. Rather than revert useful additions, the spec now reflects them. | Non-destruction unchanged (matching is read-only). Secrets/privacy unchanged. Truthfulness unchanged (heuristic, no API claim). Auditability unchanged. Scope unchanged. Matching only gets _stricter_ about treating variants as equivalents — a safety-positive direction. |
| 2026-06-04 | §6.6                                              | **Live Spotify→Apple run surfaced an Apple read hazard: an EMPTY playlist 404s on its `/tracks` relationship** (`code 40403` / "No related resources") instead of returning `{data:[]}`. `listLibraryPlaylistTracks` now absorbs ONLY that shape as `[]`; a missing-playlist 404 (`code 40400`) still propagates. Added §6.6 hazard note + a unit test (`src/clients/apple.test.ts`) for the discriminator. | Discovered during the human-supervised live test: a transfer into a freshly-created empty Apple "Sweat" playlist aborted at destination-read with HTTP 404. | Non-destruction unchanged (empty destination ⇒ all matched tracks added, the correct additive behavior). Secrets/privacy unchanged. Truthfulness **strengthened** — the 40403-vs-40400 discrimination is verified against the live error body, not assumed; a typo'd id cannot masquerade as empty. Auditability/scope unchanged. |
| 2026-06-03 | §3, §4, §9, §11.0 (new), §11.1, §11.2, §12, §12.5, §13, §14, §15 | **Multi-persona validation pass → 8 amendments** (human-directed; ran a 6-persona adversarial workflow then resolved every verified finding). Substantive changes: (1) fixed `SPOTIFY_REDIRECT_URI` mismatch in §4 (was `/callback`, now `/auth/spotify/callback` matching every other reference) + Phase 2 AC adds verbatim-agreement check; (2) **new §11.0 "Local-server security model"**: 127.0.0.1-only bind, Host/Origin validation on all routes, per-server-start CSRF token, OAuth `state` + PKCE `code_verifier` in-memory store with 10min TTL, Apple popup nonce + **short-lived (10min) developer token** so the 180-day JWT never leaves the server; Phase 1/2/3 ACs updated to implement these in sequence; (3) §12 expanded redaction list (developerToken, OAuth fields in bodies + query strings, BEGIN PRIVATE KEY pattern, configured Team/Key ID values) + per-check `preflight_checks.detail` allow-lists (no Team/Key ID leakage via `iss`/`kid`) + file perms (0600 on `.p8`, ledger, ledger-wal/shm; 0700 on `secrets/` and `data/`); (4) §9 added partial unique indexes `WHERE status='running'` on `operations` + `preflight_runs`, `finished_at` indexes, NOT NULL where appropriate, sentinels `__liked__`/`__favorites__` for `catalog.external_id`, `interrupted` status; §12.5 added startup reconciliation sweep + resume-soundness union with `operation_events.write` rows (handles platform eventual consistency); (5) implemented user-triggered rematch (Advanced toggle in §11.1, body field in §11.2, Phase 7 AC) and auto-revalidation on 404; (6) §11.1 specified ISRC fixture sourcing (storefront charts → top song → ISRC lookup); (7) §9 + §11.1 + §11.2 specified free-text duplicate-name disambiguation (0/1/≥2 matches → create/auto/422 modal); (8) coherence sweep: §3 `sync.sqlite` → `ledger.sqlite`, §9 dropped `'warn'` status, README/CLAUDE.md stale-reference cleanup; plus folded-in low-impact fixes — SSE `Last-Event-ID` reconnect protocol, UI poll-on-focus for gate state, event-log virtualization (cap at last 500 + aggregate counters), popup-failure UX (10s grace), mid-Operation gate-invalidation behavior (current Operation continues, next blocked), WAL/foreign_keys/synchronous PRAGMAs, schema_version semantics, Phase 0 `npm run build` semantics. | Human asked to deeply validate and resolve every finding from the 6-persona workflow (`wf_cc3ea7a4-e8f`). 0 blockers, 2 high, 12 medium, 14 low; all 28 verified findings either incorporated or formally deferred. Goal: reach READY-TO-BUILD with no known spec gaps that would cause first-run failure or guaranteed mid-build amendments. | Non-destruction unchanged. Secrets/privacy **strengthened**: full §11.0 security model, expanded redaction, file perms, short-lived browser-facing dev token. Truthfulness unchanged (no new API claims; sentinels and ISRC fixture sourcing are local). Auditability **strengthened**: startup sweep guarantees no orphaned `running` rows; `operation_events` canonical for resume; SSE `Last-Event-ID` enables clean replay. Scope unchanged (single-user, local). |
| 2026-06-05 | §11.0, §4, §5.1, §13 | **v2 amendment A1 (human-directed): network-deployable surface replaces the 127.0.0.1-only rule.** The §11.0 loopback-only bind becomes env-driven (`BIND_HOST`, `PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`, `ALLOWED_HOSTS`) behind an operator-supplied HTTPS reverse proxy; the Host/Origin/CSRF checks validate against the configured allowlist instead of the hardcoded loopback values; the Spotify redirect URI derives from `PUBLIC_ORIGIN`. The long-lived Apple JWT and `.p8` still never reach the browser. Default config remains loopback (no regression). | Human is taking the tool from a single-user local utility to an open-source, BYO-secrets app self-hosted in a private cloud (v2; see `todo.md`). Loopback-only was a security *mechanism*, not an invariant. | Secrets/privacy **preserved** — every loopback defense is replaced 1:1 by an env-allowlisted equivalent plus mandatory HTTPS in production; tokens stay server-side. Non-destruction, truthfulness, auditability, no-scope-creep unchanged. |
| 2026-06-05 | §1, §9, §13 | **v2 amendment A2 (human-directed): multi-user-READY data seam (single-owner now).** Add an explicit `users` table + singleton `__owner__` user and thread a `UserCtx` through storage (user-scoped tokens, catalog, operations, preflight) so genuine multi-user can be added later without a destructive schema rewrite. No signup/login/account system is built in v2; §1's "multi-user out of scope" stands operationally — only the *seam* is added. Validated cap (see `todo.md` §0): a single Spotify dev app serves ≤5 allowlisted users + owner-Premium, so the realistic distribution model is per-user self-hosting. | Human wants the open-source tool usable by family/friends without a future destructive migration. | No autonomous scope creep — this is a seam, not a shipped feature, and is human-directed. Auditability **strengthened** (operations become user-attributable). Non-destruction, secrets/privacy, truthfulness unchanged. |
| 2026-06-05 | §11.0 | **v2 amendment A3 (human-directed): one signed session cookie permitted.** §11.0's "no cookies / no session storage" relaxes to allow exactly one signed, `HttpOnly` / `Secure` / `SameSite=Strict` session cookie carrying only `{ userId }` — the access/identity seam a network-reachable instance needs. The per-server-start double-submit CSRF token is retained alongside it; no third-party cookies; the cookie holds no secret. | Loopback previously made an access seam unnecessary; a network-reachable instance requires one (v2). | Secrets/privacy **preserved** — the cookie is secretless, signed, and `SameSite=Strict`, and the CSRF defense is kept in addition. Non-destruction, truthfulness, auditability, no-scope-creep unchanged. |
| 2026-06-05 | §9 (schema extended) | **v2 Phase V2: ledger migration #2 (forward-only) implements the A2 data seam + generalizes the match cache.** Extends §9's schema (`LATEST_SCHEMA_VERSION` 1→2): new `users` table (+ singleton `__owner__`); new `track_provider_ids((identity_key, provider_id, provider_kind) → provider_ref, FK ON DELETE CASCADE)` that replaces the per-platform `tracks.spotify_id/apple_catalog_id/apple_library_id` columns (left in place, no longer read/written), backfilled from them; `user_id TEXT NOT NULL DEFAULT '__owner__'` added to `catalog`/`operations`/`preflight_runs`. Catalog PK rebuild + per-user read scoping + the token-store reshape are DEFERRED until multi-user is activated. Also fixed a latent `schema_version` singleton-row bug (PK is `version`, so `INSERT OR REPLACE` appended a row; `setVersion` now deletes-then-inserts, `getCurrentVersion` uses `MAX`). | Generalize the cache so a 3rd provider (YouTube, V7) is drop-in, and stand up the multi-user-ready data dimension without a future destructive rewrite. | Non-destruction **preserved** — migration is CREATE/INSERT/ALTER-ADD only; NO existing row deleted/rewritten; verified zero-data-loss on a real v1 ledger (1610 tracks) by test + adversarial validation. Auditability strengthened (operations user-attributable). Secrets/privacy, truthfulness, no-scope-creep unchanged (user_id is a seam, not a shipped multi-user feature). |
| 2026-06-05 | §11.0, §4 | **v2 Phase V6: implements A1 (env-driven network surface) + A3 (signed session cookie) + the deploy artifacts.** `config.ts` becomes env-driven (`BIND_HOST` default `127.0.0.1`, `PORT`, `PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`/`ALLOWED_HOSTS` defaulting from `PUBLIC_ORIGIN`, `SPOTIFY_REDIRECT_URI_EXPECTED` derived). New `http/session.ts`: optional `INSTANCE_ACCESS_TOKEN` gate — when set, `/api/*` (except `/api/session`,`/api/health`,`/api/csrf`) requires a signed cookie `mtss_session` = `base64url({userId})` + HMAC-SHA256(`SESSION_SECRET`); `HttpOnly`/`Secure`/`SameSite=Strict`, 30-day maxAge, carries only `{userId:"__owner__"}`; token compared constant-time. New `Dockerfile` (multi-stage, serves `web/dist` + API one port), `docker-compose.yml` (loopback-published), `.dockerignore`, `DEPLOY.md` (reverse-proxy/HTTPS, Spotify 5-user dev cap + redirect-URI, Apple-MusicKit-HTTPS call-outs). Default env unchanged → loopback, no login (no regression). | Realize the A1/A3 amendments as working network-deploy support so the owner can self-host privately. | Secrets/privacy **preserved** — cookie is secretless + signed + `SameSite=Strict`; `SESSION_SECRET` defaults to a per-start random; access token compared in constant time; CSRF double-submit retained; Apple JWT/`.p8` never browser-bound. Non-destruction, truthfulness, auditability, no-scope-creep unchanged. |

> Keep entries terse — one line each.
> The point is a traceable history of _why the design is what it is now_,
> so a future you (or a future agent) can tell deliberate evolution apart from drift.

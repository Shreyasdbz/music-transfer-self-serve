<!-- @format -->

# music-transfer-self-serve

> A self-hosted CLI for syncing playlists between Spotify and Apple Music, built by a coding agent.

A personal, self-hosted CLI for **bidirectional playlist sync** between Spotify and Apple Music,
with recording-level matching so the _correct version_ of each track is synced — not a remix, not
the clean edit when an explicit master exists, not a re-release.

This is a single-user tool for my own libraries. It's public so the approach is shareable, but it
is not packaged or supported for general use.

> **Design philosophy.** This project is a _living, self-healing system_, not a frozen spec. A small
> set of invariants (never delete data by surprise, never leak secrets, never invent API behavior,
> always stay auditable) is fixed; everything else evolves as the platform APIs and my needs change.
> See `blueprint.md` §0.

## What it does

- Syncs configured Spotify playlist ⇆ Apple Music playlist pairs, in both directions.
- Syncs Spotify **Liked Songs** ⇆ Apple Music **Favorite Songs**.
- Matches by **ISRC** (a unique code per recording), so explicit/clean and original/remaster/remix
  are never confused. Falls back to a scored search when no ISRC is available, and reports anything
  it can't match confidently instead of guessing.
- Plans every change as a dry-run first, and keeps a durable local ledger so runs are resumable and
  idempotent (re-running with no changes does nothing).

## Honest limits (read this)

The two platforms are not symmetric, and the tool refuses to pretend otherwise:

|                               | Spotify     | Apple Music                                        |
| ----------------------------- | ----------- | -------------------------------------------------- |
| Add tracks                    | ✅          | ✅ (appended to end; no reorder)                   |
| Remove tracks from a playlist | ✅ (opt-in) | ⚠️ unreliable via API → **report-only** by default |
| Like / Favorite               | ✅          | ✅                                                 |
| Un-like / Un-favorite         | ✅ (opt-in) | ❌ not possible via API → **report-only**          |

So the tool **guarantees convergence on additions** in both directions. Removals are opt-in,
capability-checked at runtime, and on the Apple side are surfaced in a report for you to action in
the Apple Music app rather than applied automatically.

## Prerequisites

- Node.js ≥ 20
- A Spotify account and an Apple Music subscription
- A Spotify Developer app (free) and an Apple Developer membership (for the MusicKit key)

## Setup

The build/run is mostly hands-off; you're only pulled in at four credential boundaries.

1. **Install & init**
   ```bash
   npm install
   npm run build
   npx tsx src/cli.ts init        # creates data/ ledger and sync.config.json from the example
   ```
2. **Spotify** _(Pause Points A + B)_ — create an app in the Spotify Developer Dashboard, put its
   **Client ID** in `.env` (`SPOTIFY_CLIENT_ID`), and add redirect URI
   `http://127.0.0.1:8888/callback` to the app. Then:
   ```bash
   npx tsx src/cli.ts auth spotify   # opens a browser; approve; token captured automatically
   ```
3. **Apple Music** _(Pause Points C + D)_ — in Apple Developer → Certificates, Identifiers &
   Profiles, register a Media Identifier and create a **MusicKit** private key. Put the `.p8` in
   `secrets/`, and set `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_PATH` in `.env`. Then:
   ```bash
   npx tsx src/cli.ts auth apple     # opens a local page; click Authorize; MUT captured
   ```
4. **Verify**
   ```bash
   npx tsx src/cli.ts doctor         # checks env, tokens, storefront, Apple delete-probe
   ```

## Usage

```bash
# configure pairs in sync.config.json, then:

npx tsx src/cli.ts plan all                 # dry-run: writes reports, makes NO changes
npx tsx src/cli.ts sync workout --apply     # apply additions for one pair
npx tsx src/cli.ts sync all --apply         # apply additions for all pairs

# removals are doubly-gated and will pause for confirmation:
npx tsx src/cli.ts sync workout --apply --allow-removals

npx tsx src/cli.ts report                   # summary of the last run
npx tsx src/cli.ts sync all --apply --rematch   # invalidate cached matches and re-resolve
```

Even `sync` defaults to a dry-run; nothing is written without `--apply`. Removals additionally
require `--allow-removals`, a passed capability probe, and an interactive confirmation.

## Secrets & privacy

Nothing sensitive is tracked by git. `.env`, the `.p8` key, captured tokens, the SQLite ledger, and
the `reports/` (which contain your playlist contents) are all gitignored. Spotify auth uses PKCE, so
there is no client secret to store. Don't remove entries from `.gitignore`.

## Project docs

- `blueprint.md` — full architecture, matching logic, sync algorithm, schema, and build phases.
- `CLAUDE.md` — operating manual for the coding agent that builds and maintains this.
- `PROGRESS.md` — build log. The blueprint's §15 Amendment log tracks spec evolution.

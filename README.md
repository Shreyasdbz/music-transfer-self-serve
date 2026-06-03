<!-- @format -->

# music-transfer-self-serve

> A self-hosted local web tool for running one-time playlist transfers between Spotify and Apple
> Music, built by a coding agent.

A personal, self-hosted **local web app** for transferring tracks one-way between Spotify and
Apple Music, with recording-level matching so the _correct version_ of each track lands on the
destination — not a remix, not the clean edit when an explicit master exists, not a re-release.

This is a single-user tool for my own libraries. It's public so the approach is shareable, but it
is not packaged or supported for general use.

> **Design philosophy.** This project is a _living, self-healing system_, not a frozen spec. A small
> set of invariants (never delete data by surprise, never leak secrets, never invent API behavior,
> always stay auditable) is fixed; everything else evolves as the platform APIs and my needs change.
> See `blueprint.md` §0.

## What it does

- Runs **Operations** — one-time transfers from a `source` (Spotify or Apple) to a `destination`
  (the other one) — picked in a browser UI served by the tool on `127.0.0.1`.
- Each side's target is either a **playlist** (chosen from a dropdown after refreshing the
  catalog, or entered as an id / URL / name) or the source's **Liked Songs** / **Favorite
  Songs** collection.
- Matches by **ISRC** (a unique code per recording), so explicit/clean and original/remaster/remix
  are never confused. Falls back to a scored search when no ISRC is available, and surfaces
  anything it can't match confidently in the Run panel instead of guessing.
- Keeps a durable local ledger so re-running the same Operation is idempotent (no duplicate
  writes when the source hasn't changed) and every event is auditable.

## Honest limits (read this)

- **Additive only.** Operations only ever _add_ missing tracks to the destination. They never
  remove tracks from either side, never reorder, and never touch anything outside the chosen
  destination collection.
- **One-way per run.** Each Operation transfers in a single direction. To go both ways, run two
  Operations.
- **Apple writes are appended to the end** of the destination playlist, in source order. Apple's
  API does not support insert-at-position or reorder.
- **Apple un-favorite is not possible via the public API**, and Apple playlist track _removal_
  via REST is unreliable — both reasons the tool deliberately stays additive-only in v1.

## Prerequisites

- Node.js ≥ 20
- A Spotify account and an Apple Music subscription
- A Spotify Developer app (free) and an Apple Developer membership (for the MusicKit key)

## Setup

The build/run is mostly hands-off; you're only pulled in at four credential boundaries.

1. **Install**
   ```bash
   npm install
   ```
2. **Spotify** _(Pause Points A + B)_ — create an app in the Spotify Developer Dashboard, put
   its **Client ID** in `.env` (`SPOTIFY_CLIENT_ID`), and add redirect URI
   `http://127.0.0.1:8888/auth/spotify/callback` to the app's settings.
3. **Apple Music** _(Pause Points C + D)_ — in Apple Developer → Certificates, Identifiers &
   Profiles, register a Media Identifier and create a **MusicKit** private key. Put the `.p8` in
   `secrets/`, and set `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_PATH` in `.env`.
4. **Start the UI**
   ```bash
   npx tsx src/server.ts        # serves the UI on http://127.0.0.1:8888 and opens your browser
   ```
   Click **Connect Spotify** and **Connect Apple Music** in the UI's auth panel. The auth flows
   open in popups; the local server captures the tokens and stores them in `data/tokens.json`.
5. **Verify**
   ```bash
   npx tsx src/cli.ts doctor    # checks env, tokens, storefront, Apple capability probes
   ```

## Usage

1. Start the server (`npx tsx src/server.ts`) and open the UI.
2. Click **Check permissions** in the Permissions panel. The tool runs 10 checks against both
   platforms (env vars, both tokens, Spotify scopes, sample reads on each side, an ISRC
   lookup) and streams each result live, grouped under Environment / Spotify / Apple.
   **Catalog refresh and Run are disabled until this passes**, and a pass is good for 24 hours
   — opening the UI the next day will prompt a quick re-check (3-5s). The gate also
   auto-invalidates if a real auth failure (not a transient or rate-limit) is detected on any
   downstream call.
3. Click **Update Catalog** in the Catalog panel. The tool fetches your Spotify and Apple Music
   playlists and caches them, populating the Operation form's dropdowns. (You can skip this if
   you already know the playlist ids/URLs you want — just type them into the free-text inputs.)
4. In the **Operation** panel, pick:
   - **Source** (Spotify or Apple)
   - **Destination** (the other one — auto-filtered)
   - **Source Target** — a playlist from the dropdown, or paste an id/URL/name, or pick
     **Liked / Favorites** (which disables the input)
   - **Destination Target** — same shape. Typing a new playlist name will create it on the
     destination side when the Operation runs.
5. Press **Run**. The Run panel streams live status: the current stage, a progress bar, an event
   log (matched / skipped / written / unmatched / failed), and a final summary card.

Re-running the same Operation when the source hasn't changed is a no-op — every item is already
on the destination. Past Operations are listed in the Run panel's "Past operations" disclosure
and persisted in the local SQLite ledger at `data/ledger.sqlite`.

## Secrets & privacy

Nothing sensitive is tracked by git. `.env`, the `.p8` key, captured tokens, and the SQLite
ledger (which contains your playlist contents and the per-Operation event log) are all
gitignored. Spotify auth uses PKCE, so there is no client secret to store. Don't remove entries
from `.gitignore`.

## Project docs

- `blueprint.md` — full architecture, matching logic, Operation engine, schema, and build
  phases. The §15 Amendment log tracks spec evolution.
- `CLAUDE.md` — operating manual for the coding agent that builds and maintains this.
- `PROGRESS.md` — build log.

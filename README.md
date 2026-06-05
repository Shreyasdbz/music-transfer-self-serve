<!-- @format -->

# music-transfer-self-serve

> A self-hostable web tool for one-time, additive playlist/library transfers between Spotify and
> Apple Music, with recording-level (ISRC) matching. Built and maintained by a coding agent.

Transfer tracks one-way between **Spotify** and **Apple Music** with recording-level matching, so the
_correct version_ of each track lands on the destination — not a remix, not the clean edit when an
explicit master exists, not a re-release.

It runs **locally on `127.0.0.1` by default** (no config, single user), and can also be **self-hosted
on a network** behind your own HTTPS reverse proxy so a few trusted people can use one instance — see
[`DEPLOY.md`](./DEPLOY.md). It's public so the approach is shareable; you bring your own credentials.

> **Design philosophy.** This project is a _living, self-healing system_, not a frozen spec. A small
> set of invariants (never delete data by surprise, never leak secrets, never invent API behavior,
> always stay auditable) is fixed; everything else evolves as the platform APIs and my needs change.
> See `blueprint.md` §0.

## Stack

- **Server:** [Hono](https://hono.dev) on `@hono/node-server` (TypeScript, strict).
- **Client:** [Vite](https://vitejs.dev) + [Solid](https://solidjs.com) (TSX), driven by a
  token-based **design system** (`packages/design-tokens`) with light / dark / **auto** theming and
  keyboard + screen-reader accessibility.
- **Storage:** SQLite (`better-sqlite3`) ledger, forward-migrating.
- **Layout:** npm workspaces — `server/`, `web/`, `packages/design-tokens`. The server serves the
  built client and the API on one port in production; in dev, Vite serves the UI and proxies the API.

## What it does

- Runs **Operations** — one-time transfers from a `source` (Spotify or Apple) to a `destination` (the
  other one) — picked in a browser UI served by the tool.
- Each side's target is either a **playlist** (chosen from a dropdown after refreshing the catalog,
  or entered as an id / URL / name), or the source's **Liked Songs** / **Favorite Songs** collection.
- Matches by **ISRC** (a unique code per recording), so explicit/clean and original/remaster/remix are
  never confused. Falls back to a scored search when no ISRC is available, and surfaces anything it
  can't match confidently in the status panel instead of guessing.
- Keeps a durable local ledger so re-running the same Operation is idempotent (no duplicate writes
  when the source hasn't changed), and every event is auditable.
- **YouTube Music** appears in the UI as a **"Coming soon"** placeholder; it is intentionally
  non-functional for now and excluded from transfers (a future iteration).

## Honest limits (read this)

- **Additive only.** Operations only ever _add_ missing tracks to the destination. They never remove
  tracks from either side, never reorder, and never touch anything outside the chosen destination
  collection. This is a permanent invariant, not a v1 limitation.
- **One-way per run.** Each Operation transfers in a single direction. To go both ways, run two.
- **Apple writes are appended to the end** of the destination playlist, in source order. Apple's API
  does not support insert-at-position or reorder.
- **Apple un-favorite is not possible via the public API**, and Apple playlist track _removal_ via
  REST is unreliable — both reasons the tool deliberately stays additive-only.

## Prerequisites

- Node.js ≥ 20
- A Spotify account and an Apple Music subscription
- A Spotify Developer app (free) and an Apple Developer membership (for the MusicKit key)

## Setup (local)

The build/run is mostly hands-off; you're only pulled in at four credential boundaries.

1. **Install** (from the repo root — installs all workspaces)
   ```bash
   npm install
   ```
2. **Spotify** _(Pause Points A + B)_ — create an app in the Spotify Developer Dashboard, put its
   **Client ID** in `server/.env` (`SPOTIFY_CLIENT_ID`), and add redirect URI
   `http://127.0.0.1:8888/auth/spotify/callback` to the app's settings.
   (Copy `server/.env.example` → `server/.env` to start.)
3. **Apple Music** _(Pause Points C + D)_ — in Apple Developer → Certificates, Identifiers & Profiles,
   register a Media Identifier and create a **MusicKit** private key. Put the `.p8` in
   `server/secrets/`, and set `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY_PATH` in
   `server/.env`.
4. **Start the UI**

   ```bash
   npm start        # serves the UI + API on http://127.0.0.1:8888
   ```

   Click **Connect** for Spotify and Apple Music in the auth panel. The auth flows open in popups; the
   local server captures the tokens and stores them in `server/data/tokens.json`.

   > **Browser note (Safari).** Safari's "HTTPS-Only" privacy default blocks the OAuth callback to
   > `http://127.0.0.1:8888/auth/spotify/callback` (`WebKitErrorDomain:305`), even though loopback
   > HTTP redirects are explicitly allowed by OAuth 2.0 for native apps (RFC 8252). Either disable
   > HTTPS-Only in Safari → Settings → Privacy → Advanced → "Use HTTPS" → "In Private Browsing only"
   > or "Off", or run the **Connect** flow in Chrome / Firefox / Brave. Once `tokens.json` is
   > populated, Safari is fine for normal use.

5. **Verify**
   ```bash
   npm run doctor   # runs the same 10-check preflight as the UI's permissions button
   ```

### Dev workflow

```bash
npm run dev:web    # Vite dev server (HMR) on :5173, proxying /api + /auth to the server on :8888
npm start          # the API/server (run in a second terminal)
npm run build:all  # production build: design tokens + server typecheck + web → web/dist
npm test           # server AC tests + design-token (WCAG) tests + web typecheck
```

## Self-hosting on a network

By default the server binds to `127.0.0.1`. To expose it to others, set the env-driven network config
(`PUBLIC_ORIGIN`, `BIND_HOST`, `ALLOWED_ORIGINS`/`ALLOWED_HOSTS`) and run behind an HTTPS reverse
proxy; optionally gate the instance with a shared `INSTANCE_ACCESS_TOKEN` (a login screen + signed
session cookie). A multi-stage `Dockerfile` + `docker-compose.yml` are included. **Apple MusicKit
requires HTTPS** off `localhost`, and a Spotify dev app serves at most 5 users. Full guide:
[`DEPLOY.md`](./DEPLOY.md).

## Usage

1. Start the server and open the UI. Toggle light/dark/auto with the theme control in the header.
2. Run the **permissions check** in the Setup panel. The tool runs 10 checks against both platforms
   (env vars, both tokens, Spotify scopes, sample reads on each side, an ISRC lookup) and streams each
   result live, grouped under Environment / Spotify / Apple. **Catalog refresh and transfers are
   disabled until this passes**, and a pass is good for 24 hours. The gate also auto-invalidates if a
   real auth failure (not a transient or rate-limit) is detected on any downstream call.
3. **Refresh** the catalog in the Catalog panel. The tool fetches your Spotify and Apple Music
   playlists and caches them, populating the Operation dropdowns. (You can skip this if you already
   know the playlist ids/URLs — just type them into the free-text inputs.) Each playlist row has a
   **Transfer** button that pre-fills the Operation form.
4. In the **Operation** panel, pick a source service + target and a destination service + target
   (the destination service is auto-filtered to exclude the source). Typing a new playlist name
   creates it on the destination side when the Operation runs.
5. Press **Start transfer**. The status panel streams live: the current stage, running counters
   (matched / skipped / written / unmatched / failed), an event log, and a final summary. If a write
   fails because a token lapsed, the log names the exact reconnect button to click.

Re-running the same Operation when the source hasn't changed is a no-op. Past Operations are listed in
the History panel and persisted in the local SQLite ledger at `server/data/ledger.sqlite`.

## Secrets & privacy

Nothing sensitive is tracked by git. `.env`, the `.p8` key, captured tokens, and the SQLite ledger
(which contains your playlist contents and the per-Operation event log) are all gitignored. Spotify
auth uses PKCE, so there is no client secret to store. The long-lived Apple developer JWT and the
`.p8` never reach the browser. Don't remove entries from `.gitignore`.

## Project docs

- `blueprint.md` — full architecture, matching logic, Operation engine, schema, and build phases. The
  §15 Amendment log tracks spec evolution (including the v2 network/multi-user-ready/session changes).
- `DEPLOY.md` — self-hosting on a network (reverse proxy, HTTPS, Docker, access token).
- `CLAUDE.md` — operating manual for the coding agent that builds and maintains this.
- `PROGRESS.md` — build log.

## License

[MIT](./LICENSE) © Shreyas (@shreyasdbz). `package.json` keeps `"private": true` to prevent accidental
publishing to the npm registry — this is a GitHub-shared personal tool, not an npm package.

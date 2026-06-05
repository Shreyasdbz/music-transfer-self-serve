<!-- @format -->

# DEPLOY.md — self-hosting music-transfer-self-serve

This tool is **open-source, bring-your-own-secrets, and self-hostable**. By default it binds to
`127.0.0.1` and behaves exactly like the local app (no config needed). To expose it on a network
you supply your own credentials and run it behind an **HTTPS reverse proxy**. You operate it; this
guide just makes that doable.

> **Scope note (single-owner now).** The data model is multi-user-_ready_ (every record carries a
> `user_id`, defaulting to `__owner__`), but v2 ships **single-owner**: one access token gates the
> instance, and everyone who logs in shares the one owner's connected accounts. True per-user
> accounts are a later milestone.

---

## 1. Prerequisites

- **Docker** (+ compose) on a host you control, OR Node ≥ 20 to run it directly.
- A **domain name** and a **reverse proxy that terminates HTTPS** (Caddy, nginx, Traefik). Apple
  MusicKit **requires HTTPS** off `localhost`, so a public deployment must be served over TLS.
- A **Spotify** developer app (Client ID; PKCE — no secret) and an **Apple Music** developer key
  (`.p8`, Team ID, Key ID). See the main README for obtaining these.

### ⚠️ Two platform realities to know before you deploy (verified 2026-06)

- **Spotify caps a hosted instance at 5 users.** Spotify **development mode** allows **5
  authenticated users**, each added to the dashboard's User Management allowlist, and the **app
  owner must hold Spotify Premium**. **Extended Quota Mode** (more users) is granted to
  **organizations only** with a launched service ≥ 250k MAU — effectively unreachable for a hobby
  instance. So the realistic models are: **(a)** one instance for ≤ 5 trusted people you allowlist,
  or **(b)** each person self-hosts their own copy with their own Spotify app. Plan accordingly.
- **Apple MusicKit needs HTTPS + a valid dev-token JWT.** There is **no per-origin allowlist** to
  register at Apple — MusicKit authorizes from any HTTPS origin as long as the server serves a
  valid developer-token JWT (which this app mints and refreshes from your `.p8`). Just put it behind
  TLS; `http://` works only for local `localhost` dev.

When you register the Spotify app, add your **public** redirect URI
`https://YOUR_DOMAIN/auth/spotify/callback` (you may keep the loopback one for local dev too).

---

## 2. Configuration (`.env`)

Copy `server/.env.example` to `.env` at the repo root (compose reads it) and fill it in. Network +
access keys (all optional — omitting them = loopback/local behavior):

| Key | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:8888` | The origin the browser sees, e.g. `https://music.example.com`. The Spotify redirect URI, the Origin allowlist, and the Host allowlist all derive from this. |
| `BIND_HOST` | `127.0.0.1` | Address the server listens on. Compose sets `0.0.0.0` (the published port is loopback-only). |
| `PORT` | `8888` | Listen port. |
| `ALLOWED_ORIGINS` | `[PUBLIC_ORIGIN]` | CSV of origins accepted on POSTs (CSRF/Origin defense). |
| `ALLOWED_HOSTS` | `host of PUBLIC_ORIGIN` | CSV of `Host` headers accepted (DNS-rebinding defense). Set to your domain if the proxy passes a different Host. |
| `INSTANCE_ACCESS_TOKEN` | _(empty = open)_ | When set, the instance shows a login screen and requires this token once; a signed `HttpOnly`/`Secure`/`SameSite=Strict` session cookie is then issued. Generate a long random value. |
| `SESSION_SECRET` | random per start | HMAC secret for the session cookie. **Set this** so sessions survive restarts. |

Plus the credential keys (Spotify/Apple) from `.env.example`. **Never commit `.env` or the `.p8`.**

---

## 3. Reverse proxy + HTTPS

Example **Caddy** config (automatic HTTPS):

```caddyfile
music.example.com {
    reverse_proxy 127.0.0.1:8888
}
```

Caddy forwards the public `Host` and `Origin` through. Set `PUBLIC_ORIGIN=https://music.example.com`
in `.env`; `ALLOWED_HOSTS`/`ALLOWED_ORIGINS` then default correctly. If your proxy rewrites `Host`,
add the rewritten value to `ALLOWED_HOSTS`. **Do not** let the proxy strip the `Origin` header on
POSTs (the CSRF/Origin defense needs it).

---

## 4. Run

```bash
# Build + start (reads .env, persists ./server/data, mounts ./server/secrets ro)
docker compose up -d --build

# Logs
docker compose logs -f
```

Without Docker: `npm ci && npm run build:all && (cd server && npm start)` with the env exported
(`build:all` typechecks the server and builds the client; `build:web` alone skips the server check).

The server serves the built UI **and** the API on one port. On first start it migrates the ledger
forward (zero data loss) — **back up `server/data/ledger.sqlite` before upgrading** (migrations are
forward-only).

---

## 5. Access control

If `INSTANCE_ACCESS_TOKEN` is set, visitors see a login screen and must enter the token once; the
server then sets a signed, `HttpOnly`, `Secure`, `SameSite=Strict` session cookie. The CSRF token is
retained alongside it. The cookie carries only `{ userId: "__owner__" }` — no secret. If the token is
unset (local single-owner), there is no login (loopback is the protection).

---

## 6. Data, backup, security posture

- **Persistence:** the ledger (`server/data/ledger.sqlite`) and tokens (`server/data/tokens.json`)
  live in the mounted `server/data` volume. The Apple `.p8` lives in `server/secrets` (read-only).
- **Backups:** copy `server/data/` regularly. Always back it up before pulling a new version
  (forward-only migrations).
- **Secrets never reach the browser:** the 180-day Apple developer JWT and the `.p8` stay
  server-side; the browser only ever sees the 10-minute MusicKit popup token. Logs redact tokens,
  keys, and the Team/Key IDs.
- **Additive-only:** the tool only ever _adds_ tracks to a destination — it never removes,
  unfavorites, or reorders.

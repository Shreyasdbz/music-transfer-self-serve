// Auth-related HTTP routes for Spotify and Apple (Hono).
//   GET  /api/auth/status
//   POST /api/auth/spotify/start    GET  /auth/spotify/callback
//   POST /api/auth/apple/start      POST /api/auth/apple/callback

import type { Hono } from "hono";
import { autoCloseHtml, err, readJson } from "./respond.js";
import {
  buildAuthorizeUrl,
  getConnectedState as spotifyConnected,
  handleCallback,
  startStateSweeper,
} from "../auth/spotify.js";
import {
  buildPopupStart as buildApplePopupStart,
  getConnectedState as appleConnected,
  handleCallback as handleAppleCallback,
  startNonceSweeper,
} from "../auth/apple.js";
import { log } from "../util/log.js";

export function registerAuthRoutes(app: Hono): void {
  startStateSweeper();
  startNonceSweeper();

  app.get("/api/auth/status", (c) =>
    c.json({ spotify: spotifyConnected(), apple: appleConnected() }),
  );

  app.post("/api/auth/spotify/start", (c) => {
    try {
      const { authorizeUrl } = buildAuthorizeUrl();
      return c.json({ authorizeUrl });
    } catch (e) {
      const message = (e as Error).message;
      log.warn("auth.spotify_start_failed", { message });
      return err(c, 500, message);
    }
  });

  app.get("/auth/spotify/callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    const errParam = c.req.query("error");

    if (errParam) {
      // Log the raw error server-side, but NEVER echo it into the HTML — `error`
      // is attacker-controllable via a top-level GET navigation and the callback
      // HTML runs in the trusted local origin.
      log.warn("auth.spotify_callback_user_error", { error: errParam });
      return autoCloseHtml(c, "Spotify authorization cancelled.");
    }
    if (!state || !code) {
      return err(c, 400, "missing_state_or_code");
    }
    const result = await handleCallback(state, code);
    switch (result.kind) {
      case "ok":
        log.info("auth.spotify_connected");
        return autoCloseHtml(c, "Spotify connected.");
      case "state_unknown":
      case "state_expired":
        return err(c, 403, result.kind);
      case "exchange_failed":
        return err(c, 502, `spotify_exchange_failed_${result.status}`);
    }
  });

  app.post("/api/auth/apple/start", (c) => {
    try {
      return c.json(buildApplePopupStart());
    } catch (e) {
      const message = (e as Error).message;
      log.warn("auth.apple_start_failed", { message });
      return err(c, 500, message);
    }
  });

  app.post("/api/auth/apple/callback", async (c) => {
    let body: { nonce?: string; mut?: string };
    try {
      body = await readJson<{ nonce?: string; mut?: string }>(c);
    } catch {
      return err(c, 400, "invalid_json");
    }
    const nonce = body.nonce ?? "";
    const mut = body.mut ?? "";
    if (!nonce) {
      return err(c, 400, "missing_nonce");
    }
    const result = handleAppleCallback(nonce, mut);
    switch (result.kind) {
      case "ok":
        log.info("auth.apple_connected");
        return c.json({ ok: true });
      case "nonce_unknown":
      case "nonce_expired":
        return err(c, 403, result.kind);
      case "mut_missing":
        return err(c, 400, result.kind);
    }
  });
}

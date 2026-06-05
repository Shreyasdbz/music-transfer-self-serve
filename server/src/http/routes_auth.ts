// Auth-related HTTP routes for Spotify (Phase 2) and Apple (Phase 3).
// Phase 2: POST /api/auth/spotify/start, GET /auth/spotify/callback.
// Phase 3: POST /api/auth/apple/start, POST /api/auth/apple/callback.
// Both phases: GET /api/auth/status.

import { BodyTooLargeError, readJsonBody, route, sendAutoCloseHtml, sendJson, sendStatus } from "./server.js";
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

export function registerAuthRoutes(): void {
  startStateSweeper();
  startNonceSweeper();

  route("GET", "/api/auth/status", ({ res }) => {
    sendJson(res, 200, {
      spotify: spotifyConnected(),
      apple: appleConnected(),
    });
  });

  route("POST", "/api/auth/spotify/start", ({ res }) => {
    try {
      const { authorizeUrl } = buildAuthorizeUrl();
      sendJson(res, 200, { authorizeUrl });
    } catch (err) {
      const message = (err as Error).message;
      log.warn("auth.spotify_start_failed", { message });
      sendStatus(res, 500, message);
    }
  });

  route("GET", "/auth/spotify/callback", async ({ url, res }) => {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const errParam = url.searchParams.get("error");

    if (errParam) {
      // Log the raw error server-side, but NEVER echo it into the HTML
      // response — `error` is attacker-controllable via a top-level GET
      // navigation, and the callback HTML runs in the trusted local origin.
      // The redacting logger handles raw error strings safely.
      log.warn("auth.spotify_callback_user_error", { error: errParam });
      sendAutoCloseHtml(res, "Spotify authorization cancelled.");
      return;
    }
    if (!state || !code) {
      sendStatus(res, 400, "missing_state_or_code");
      return;
    }
    const result = await handleCallback(state, code);
    switch (result.kind) {
      case "ok":
        log.info("auth.spotify_connected");
        sendAutoCloseHtml(res, "Spotify connected.");
        return;
      case "state_unknown":
      case "state_expired":
        sendStatus(res, 403, result.kind);
        return;
      case "exchange_failed":
        sendStatus(res, 502, `spotify_exchange_failed_${result.status}`);
        return;
    }
  });

  route("POST", "/api/auth/apple/start", ({ res }) => {
    try {
      const start = buildApplePopupStart();
      sendJson(res, 200, start);
    } catch (err) {
      const message = (err as Error).message;
      log.warn("auth.apple_start_failed", { message });
      sendStatus(res, 500, message);
    }
  });

  route("POST", "/api/auth/apple/callback", async ({ req, res }) => {
    let body: { nonce?: string; mut?: string };
    try {
      body = await readJsonBody(req);
    } catch (err) {
      // Let oversize bodies bubble to the global 413 path; only JSON parse
      // errors become 400 here.
      if (err instanceof BodyTooLargeError) throw err;
      sendStatus(res, 400, "invalid_json");
      return;
    }
    const nonce = body.nonce ?? "";
    const mut = body.mut ?? "";
    if (!nonce) {
      sendStatus(res, 400, "missing_nonce");
      return;
    }
    const result = handleAppleCallback(nonce, mut);
    switch (result.kind) {
      case "ok":
        log.info("auth.apple_connected");
        sendJson(res, 200, { ok: true });
        return;
      case "nonce_unknown":
      case "nonce_expired":
        sendStatus(res, 403, result.kind);
        return;
      case "mut_missing":
        sendStatus(res, 400, result.kind);
        return;
    }
  });
}

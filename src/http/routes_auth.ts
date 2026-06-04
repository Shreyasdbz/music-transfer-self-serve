// Auth-related HTTP routes for Spotify (Phase 2) and Apple (Phase 3).
// Phase 2 here: POST /api/auth/spotify/start, GET /auth/spotify/callback,
// GET /api/auth/status.

import { route, sendAutoCloseHtml, sendJson, sendStatus } from "./server.js";
import {
  buildAuthorizeUrl,
  getConnectedState as spotifyConnected,
  handleCallback,
  startStateSweeper,
} from "../auth/spotify.js";
import { log } from "../util/log.js";

export function registerAuthRoutes(): void {
  startStateSweeper();

  route("GET", "/api/auth/status", ({ res }) => {
    sendJson(res, 200, {
      spotify: spotifyConnected(),
      apple: { connected: false }, // Phase 3 fills this in
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
      log.warn("auth.spotify_callback_user_error", { error: errParam });
      sendAutoCloseHtml(res, `Spotify authorization cancelled: ${errParam}`);
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
}

// Phase 2 UI: auth panel only. Phase 3+ adds Apple, preflight, catalog, run panels.
// Vanilla JS, no framework, no bundler.

const csrfToken = document.querySelector('meta[name="csrf-token"]').content;

const spotifyStatusEl = document.getElementById("spotify-status");
const spotifyBtn = document.getElementById("spotify-connect");
const appleStatusEl = document.getElementById("apple-status");
const appleBtn = document.getElementById("apple-connect");
const messageEl = document.getElementById("auth-message");

function setMessage(text, tone = "info") {
  messageEl.textContent = text;
  if (text) messageEl.dataset.tone = tone;
  else delete messageEl.dataset.tone;
}

async function refreshAuthStatus() {
  try {
    const r = await fetch("/api/auth/status", { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`status_${r.status}`);
    const j = await r.json();
    renderSpotify(j.spotify);
    renderApple(j.apple);
  } catch (err) {
    setMessage(`Could not load auth status: ${err.message}`, "error");
  }
}

function renderSpotify(s) {
  if (s.connected) {
    spotifyStatusEl.textContent = "connected";
    spotifyStatusEl.dataset.state = "connected";
    spotifyBtn.textContent = "Reconnect Spotify";
  } else {
    spotifyStatusEl.textContent = "not connected";
    spotifyStatusEl.dataset.state = "disconnected";
    spotifyBtn.textContent = "Connect Spotify";
  }
}

function renderApple(a) {
  if (a.connected) {
    appleStatusEl.textContent = "connected";
    appleStatusEl.dataset.state = "connected";
    appleBtn.textContent = "Reconnect Apple Music";
  } else {
    appleStatusEl.textContent = "not connected";
    appleStatusEl.dataset.state = "disconnected";
    appleBtn.textContent = "Connect Apple Music";
  }
}

let inFlightPopup = null;
let popupWatchInterval = null;

/** Watch a popup and, after it closes:
 *   - re-poll auth status (so the panel flips green if the flow succeeded)
 *   - clear the "Opening…" message on success
 *   - surface "did not complete" only if the *expected* platform is still
 *     not connected after a 10s grace
 *
 * `platform` is "spotify" | "apple" — needed because the grace check was
 * hardcoded to the Spotify-side el originally, which left the Apple flow's
 * "Opening Apple Music authorization…" message stuck on screen even after
 * the popup closed and the auth succeeded.
 */
function watchPopup(popup, platform) {
  if (!popup) {
    setMessage(
      "Your browser blocked the popup; allow popups for 127.0.0.1:8888 and try again.",
      "error",
    );
    return;
  }
  inFlightPopup = popup;
  if (popupWatchInterval) clearInterval(popupWatchInterval);
  popupWatchInterval = setInterval(() => {
    if (!inFlightPopup || inFlightPopup.closed) {
      clearInterval(popupWatchInterval);
      popupWatchInterval = null;
      // After the popup closes (success OR cancel), re-poll status, then
      // either clear the "Opening…" message on success, or surface the
      // failure on the 10s grace per blueprint §11.1.
      setTimeout(async () => {
        await refreshAuthStatus();
        const statusEl = platform === "apple" ? appleStatusEl : spotifyStatusEl;
        if (statusEl.dataset.state === "connected") {
          setMessage(""); // success — clear the "Opening…" line
        }
      }, 250);
      setTimeout(() => {
        const statusEl = platform === "apple" ? appleStatusEl : spotifyStatusEl;
        if (statusEl.dataset.state !== "connected") {
          setMessage("Connect attempt did not complete; try again.", "error");
        }
      }, 10_000);
      inFlightPopup = null;
    }
  }, 500);
}

async function connectSpotify() {
  setMessage("Opening Spotify authorization…");
  try {
    const r = await fetch("/api/auth/spotify/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`server returned ${r.status}: ${body}`);
    }
    const { authorizeUrl } = await r.json();
    const popup = window.open(authorizeUrl, "spotify-auth", "width=520,height=720");
    watchPopup(popup, "spotify");
  } catch (err) {
    setMessage(`Could not start Spotify auth: ${err.message}`, "error");
  }
}

async function connectApple() {
  setMessage("Opening Apple Music authorization…");
  // The popup loads /musickit.html, which itself POSTs /api/auth/apple/start
  // for the short-lived dev token + nonce. We just have to open the popup;
  // CSRF + Origin are enforced server-side inside that page's fetches.
  const popup = window.open("/musickit.html", "apple-auth", "width=520,height=720");
  watchPopup(popup, "apple");
}

spotifyBtn.addEventListener("click", connectSpotify);
appleBtn.addEventListener("click", connectApple);
window.addEventListener("focus", refreshAuthStatus);
refreshAuthStatus();

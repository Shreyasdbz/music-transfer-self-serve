// Phase 2 UI: auth panel only. Phase 3+ adds Apple, preflight, catalog, run panels.
// Vanilla JS, no framework, no bundler.

const csrfToken = document.querySelector('meta[name="csrf-token"]').content;

const spotifyStatusEl = document.getElementById("spotify-status");
const spotifyBtn = document.getElementById("spotify-connect");
const appleStatusEl = document.getElementById("apple-status");
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
  } else {
    appleStatusEl.textContent = "not connected (Phase 3)";
    appleStatusEl.dataset.state = "disconnected";
  }
}

let inFlightPopup = null;
let popupWatchInterval = null;

function watchPopup(popup) {
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
      // After the popup closes (success OR cancel), re-poll status.
      // Per blueprint §11.1, a 10s grace handles the "closed without callback" case.
      setTimeout(() => {
        refreshAuthStatus();
      }, 250);
      setTimeout(() => {
        // If we're still not connected after 10s, the user likely cancelled.
        if (spotifyStatusEl.dataset.state !== "connected") {
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
    watchPopup(popup);
  } catch (err) {
    setMessage(`Could not start Spotify auth: ${err.message}`, "error");
  }
}

spotifyBtn.addEventListener("click", connectSpotify);
window.addEventListener("focus", refreshAuthStatus);
refreshAuthStatus();

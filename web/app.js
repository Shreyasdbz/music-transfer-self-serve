// Phase 2 UI: auth panel only. Phase 3+ adds Apple, preflight, catalog, run panels.
// Vanilla JS, no framework, no bundler.

// Read the CSRF token defensively — if the static handler's <meta> injection
// regressed (e.g. someone touches static.ts again), don't kill the whole
// script with a TypeError. The fetch helpers will then send no token and the
// server will reject with 403, which is the right failure mode for that bug.
const csrfMeta = document.querySelector('meta[name="csrf-token"]');
const csrfToken = csrfMeta ? csrfMeta.content : "";
if (!csrfToken) {
  console.error("CSRF token missing from HTML — refresh, and if the problem persists, check /static.ts injection.");
}

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

// ── Permissions preflight + gating ──────────────────────────────────────

const checkBtn = document.getElementById("check-permissions");
const preflightSummary = document.getElementById("preflight-summary");
const gateBanner = document.getElementById("gate-banner");
const updateCatalogBtn = document.getElementById("update-catalog");
const catalogStatus = document.getElementById("catalog-status");
const runBtn = document.getElementById("run-operation");
const operationStatus = document.getElementById("operation-status");

const MARK = { pass: "✅", fail: "❌", skip: "⏭️" };

// Map a check name to its UI group.
function checkGroup(name) {
  if (name === "env") return "env";
  if (name.startsWith("spotify")) return "spotify";
  return "apple";
}

function groupList(group) {
  return document.querySelector(`.check-group[data-group="${group}"] ul`);
}

function clearChecklist() {
  for (const g of ["env", "spotify", "apple"]) groupList(g).innerHTML = "";
}

function detailLine(detail) {
  if (!detail) return "";
  if (detail.error_message_safe) return detail.error_message_safe;
  return Object.entries(detail)
    .filter(([k]) => k !== "error_class")
    .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(",")}]` : v}`)
    .join(" ");
}

function renderCheck(evt) {
  const list = groupList(checkGroup(evt.name));
  let li = list.querySelector(`li[data-name="${evt.name}"]`);
  if (!li) {
    li = document.createElement("li");
    li.dataset.name = evt.name;
    list.appendChild(li);
  }
  li.className = `check-${evt.status}`;
  const detail = detailLine(evt.detail);
  li.textContent = `${MARK[evt.status] ?? "?"} ${evt.name}${detail ? " — " + detail : ""}`;
}

async function refreshGate() {
  try {
    const r = await fetch("/api/gate", { headers: { Accept: "application/json" } });
    const gate = await r.json();
    applyGate(gate);
    return gate;
  } catch (err) {
    console.error("gate fetch failed", err);
    return { open: false, reason: "Could not reach server." };
  }
}

function applyGate(gate) {
  gateBanner.hidden = false;
  gateBanner.textContent = gate.open ? "✅ Permissions check passed — Catalog and Run are enabled." : `🔒 ${gate.reason}`;
  gateBanner.dataset.state = gate.open ? "open" : "closed";
  for (const btn of [updateCatalogBtn, runBtn]) {
    btn.disabled = !gate.open;
    btn.title = gate.open ? "" : gate.reason;
  }
}

async function runPreflight() {
  checkBtn.disabled = true;
  preflightSummary.textContent = "running…";
  clearChecklist();
  let id;
  try {
    const r = await fetch("/api/preflight/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    });
    if (r.status === 409) {
      preflightSummary.textContent = "a check is already running";
      checkBtn.disabled = false;
      return;
    }
    if (!r.ok) throw new Error(`server returned ${r.status}`);
    ({ id } = await r.json());
  } catch (err) {
    preflightSummary.textContent = `failed to start: ${err.message}`;
    checkBtn.disabled = false;
    return;
  }

  const es = new EventSource(`/api/preflight/${id}/events`);
  let pass = 0;
  let total = 0;
  es.addEventListener("check", (e) => {
    const evt = JSON.parse(e.data);
    renderCheck(evt);
    total++;
    if (evt.status === "pass") pass++;
    preflightSummary.textContent = `${pass}/${total} passed…`;
  });
  es.addEventListener("complete", async (e) => {
    const done = JSON.parse(e.data);
    es.close();
    preflightSummary.textContent = `${done.status} — ${pass} checks passed`;
    checkBtn.disabled = false;
    await refreshGate(); // (d) re-poll after the SSE stream ends
  });
  es.onerror = () => {
    es.close();
    checkBtn.disabled = false;
    refreshGate();
  };
}

async function postGated(url, statusEl) {
  statusEl.textContent = "…";
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 412) {
      statusEl.textContent = `blocked: ${body.reason ?? "permissions check required"}`;
      await refreshGate(); // (c) re-poll after a 412
      return;
    }
    if (r.status === 501) {
      statusEl.textContent = "ready (feature lands in a later phase)";
      return;
    }
    statusEl.textContent = r.ok ? "ok" : `error ${r.status}`;
  } catch (err) {
    statusEl.textContent = `error: ${err.message}`;
  }
}

checkBtn.addEventListener("click", runPreflight);
updateCatalogBtn.addEventListener("click", () => postGated("/api/catalog/refresh", catalogStatus));
runBtn.addEventListener("click", () => postGated("/api/operations", operationStatus));

window.addEventListener("focus", () => {
  refreshAuthStatus();
  refreshGate();
});

refreshAuthStatus();
refreshGate();

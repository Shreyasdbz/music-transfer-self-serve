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

// Auth/credential checks whose failure is fixed by reconnecting a platform —
// when one fails, the check row gets an inline "Reconnect" action that drives
// the same popup as the Auth panel button (§13 Phase 8: exact next click).
const RECONNECT_FOR_CHECK = {
  spotify_token: { label: "Reconnect Spotify", action: () => connectSpotify() },
  spotify_scopes: { label: "Reconnect Spotify to re-consent", action: () => connectSpotify() },
  spotify_me: { label: "Reconnect Spotify", action: () => connectSpotify() },
  apple_mut: { label: "Reconnect Apple Music", action: () => connectApple() },
  apple_dev_token: { label: "Reconnect Apple Music", action: () => connectApple() },
};

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
  // Inline reconnect CTA on a failed auth check.
  const cta = RECONNECT_FOR_CHECK[evt.name];
  if (evt.status === "fail" && cta) {
    const a = document.createElement("button");
    a.type = "button";
    a.className = "reconnect-cta";
    a.textContent = cta.label;
    a.addEventListener("click", cta.action);
    li.appendChild(document.createTextNode("  "));
    li.appendChild(a);
  }
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
  gateBanner.dataset.state = gate.open ? "open" : "closed";
  if (gate.open) {
    gateBanner.textContent = "✅ Permissions check passed — Catalog and Run are enabled.";
  } else {
    // When the gate closed because of an auth/scope failure (auto-invalidation),
    // point the user at the fix: re-check, then reconnect the failing platform.
    const authClosed = /auth failure|scope\/permission/i.test(gate.reason || "");
    gateBanner.textContent = `🔒 ${gate.reason}` + (authClosed ? "  Run Check permissions; the failing check will offer a Reconnect button." : "");
  }
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

// ── Catalog refresh ─────────────────────────────────────────────────────

const cancelCatalogBtn = document.getElementById("cancel-catalog");
const catalogFetched = document.getElementById("catalog-fetched");
const catalogProgress = document.getElementById("catalog-progress");

let catalogRows = []; // last loaded catalog

function fmtTime(iso) {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function loadCatalog() {
  try {
    const r = await fetch("/api/catalog", { headers: { Accept: "application/json" } });
    const j = await r.json();
    catalogRows = j.rows ?? [];
    catalogFetched.textContent = `Last fetched — Spotify: ${fmtTime(j.last_fetched?.spotify)} · Apple: ${fmtTime(j.last_fetched?.apple)}`;
    populateTargetDropdowns();
  } catch (err) {
    catalogStatus.textContent = `could not load catalog: ${err.message}`;
  }
}

async function updateCatalog() {
  catalogStatus.textContent = "starting…";
  catalogProgress.textContent = "";
  try {
    const r = await fetch("/api/catalog/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 412) {
      catalogStatus.textContent = `blocked: ${body.reason ?? "permissions check required"}`;
      await refreshGate();
      return;
    }
    if (r.status === 409) {
      catalogStatus.textContent = "a refresh is already running";
      return;
    }
    if (!r.ok) throw new Error(`server returned ${r.status}`);
  } catch (err) {
    catalogStatus.textContent = `failed: ${err.message}`;
    return;
  }

  updateCatalogBtn.disabled = true;
  cancelCatalogBtn.hidden = false;
  const es = new EventSource("/api/catalog/events");
  const platformCounts = {};
  const render = () => {
    catalogProgress.textContent = Object.entries(platformCounts)
      .map(([p, c]) => `${p}: ${c.done}${c.total ? "/" + c.total : ""}`)
      .join("   ");
  };
  es.addEventListener("platform_start", (e) => {
    const v = JSON.parse(e.data);
    platformCounts[v.platform] = { done: 0, total: 0 };
    catalogStatus.textContent = `refreshing ${v.platform}…`;
    render();
  });
  es.addEventListener("playlist", (e) => {
    const v = JSON.parse(e.data);
    platformCounts[v.platform] = { done: v.index, total: v.total };
    render();
  });
  es.addEventListener("platform_done", (e) => {
    const v = JSON.parse(e.data);
    platformCounts[v.platform] = { done: v.count, total: v.count };
    render();
  });
  const finish = async (label) => {
    es.close();
    catalogStatus.textContent = label;
    updateCatalogBtn.disabled = false;
    cancelCatalogBtn.hidden = true;
    await loadCatalog();
  };
  es.addEventListener("complete", () => finish("catalog updated"));
  es.addEventListener("cancelled", () => finish("cancelled (kept what was fetched)"));
  es.addEventListener("error", (e) => {
    if (e.data) {
      const v = JSON.parse(e.data);
      catalogStatus.textContent = `error on ${v.platform}: ${v.message}`;
    }
  });
  es.onerror = () => finish("disconnected");
}

async function cancelCatalog() {
  cancelCatalogBtn.disabled = true;
  await fetch("/api/catalog/refresh/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
  }).catch(() => {});
  cancelCatalogBtn.disabled = false;
}

updateCatalogBtn.addEventListener("click", updateCatalog);
cancelCatalogBtn.addEventListener("click", cancelCatalog);

// ── Operation form ──────────────────────────────────────────────────────

const sourceRadios = [...document.querySelectorAll('input[name="source"]')];
const destRadios = [...document.querySelectorAll('input[name="destination"]')];
const srcSelect = document.getElementById("source-target-select");
const srcInput = document.getElementById("source-target-input");
const dstSelect = document.getElementById("destination-target-select");
const dstInput = document.getElementById("destination-target-input");
const rematchEl = document.getElementById("rematch");

function selectedSource() {
  return sourceRadios.find((r) => r.checked)?.value;
}
function selectedDestination() {
  return destRadios.find((r) => r.checked)?.value;
}

function populateOneDropdown(select, platform) {
  select.innerHTML = '<option value="">— pick a playlist —</option>';
  if (!platform) return;
  // Pin Liked/Favorites first.
  const pinned = catalogRows.filter((r) => r.platform === platform && (r.kind === "liked" || r.kind === "favorites"));
  for (const p of pinned) {
    const o = document.createElement("option");
    o.value = `${p.kind}:`;
    o.textContent = `★ ${p.name}`;
    select.appendChild(o);
  }
  const playlists = catalogRows.filter((r) => r.platform === platform && r.kind === "playlist");
  for (const p of playlists) {
    const o = document.createElement("option");
    o.value = `playlist:${p.external_id}`;
    o.textContent = p.track_count != null ? `${p.name} (${p.track_count})` : p.name;
    select.appendChild(o);
  }
}

function populateTargetDropdowns() {
  populateOneDropdown(srcSelect, selectedSource());
  populateOneDropdown(dstSelect, selectedDestination());
}

// Auto-filter: source ≠ destination. When source changes, disable the matching
// destination radio and flip if it was selected. Reset targets on change.
function onSourceChange() {
  const src = selectedSource();
  for (const r of destRadios) {
    r.disabled = r.value === src;
    if (r.value === src && r.checked) {
      const other = destRadios.find((d) => d.value !== src);
      if (other) other.checked = true;
    }
  }
  resetTargets();
  populateTargetDropdowns();
  updateRunEnabled();
}
function onDestChange() {
  resetTargets();
  populateTargetDropdowns();
  updateRunEnabled();
}
function resetTargets() {
  srcSelect.value = "";
  dstSelect.value = "";
  srcInput.value = "";
  dstInput.value = "";
  srcInput.disabled = false;
  dstInput.disabled = false;
}

// Mutual exclusivity between dropdown and free-text input on each side.
function wireMutualExclusion(select, input) {
  select.addEventListener("change", () => {
    if (select.value) {
      input.value = "";
      input.disabled = true; // dropdown chosen
    } else {
      input.disabled = false;
    }
    updateRunEnabled();
  });
  input.addEventListener("input", () => {
    if (input.value) select.value = "";
    updateRunEnabled();
  });
}
wireMutualExclusion(srcSelect, srcInput);
wireMutualExclusion(dstSelect, dstInput);

function sideHasTarget(select, input) {
  return Boolean(select.value || input.value.trim());
}

let operationRunning = false;
let gateOpen = false;

function updateRunEnabled() {
  const src = selectedSource();
  const dst = selectedDestination();
  const ok =
    gateOpen &&
    src &&
    dst &&
    src !== dst &&
    sideHasTarget(srcSelect, srcInput) &&
    sideHasTarget(dstSelect, dstInput) &&
    !operationRunning;
  runBtn.disabled = !ok;
  if (!gateOpen) runBtn.title = "Run a passing permissions check first.";
  else if (!src || !dst) runBtn.title = "Pick a source and destination.";
  else if (src === dst) runBtn.title = "Source and destination must differ.";
  else if (!sideHasTarget(srcSelect, srcInput) || !sideHasTarget(dstSelect, dstInput)) runBtn.title = "Pick a target on each side.";
  else runBtn.title = "";
}

// Lock the operation form while a run is in flight, so the form state can't be
// changed out from under the running operation (which would, e.g., make the
// mid-run reconnect hint name the wrong platform). The Run button is gated
// separately by updateRunEnabled().
function setFormDisabled(disabled) {
  for (const el of [...sourceRadios, ...destRadios, srcSelect, srcInput, dstSelect, dstInput, rematchEl]) {
    el.disabled = disabled;
  }
}

sourceRadios.forEach((r) => r.addEventListener("change", onSourceChange));
destRadios.forEach((r) => r.addEventListener("change", onDestChange));

// Build a target payload for one side from its select + input.
function buildTarget(select, input, extra = {}) {
  if (select.value) {
    const [kind, id] = select.value.split(":");
    if (kind === "liked" || kind === "favorites") return { kind };
    return { kind: "playlist", id };
  }
  return { kind: "playlist", query: input.value.trim(), ...extra };
}

async function submitOperation(extraDest = {}) {
  operationStatus.textContent = "…";
  const payload = {
    source: selectedSource(),
    destination: selectedDestination(),
    sourceTarget: buildTarget(srcSelect, srcInput),
    destinationTarget: buildTarget(dstSelect, dstInput, extraDest),
    rematch: rematchEl.checked,
  };
  try {
    const r = await fetch("/api/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 412) {
      operationStatus.textContent = `blocked: ${body.reason ?? "permissions required"}`;
      await refreshGate();
      return;
    }
    if (r.status === 422) {
      if (body.error === "ambiguous_name" && body.candidates) {
        openDisambig(body.side, body.candidates);
        operationStatus.textContent = `pick which "${body.side}" playlist`;
        return;
      }
      operationStatus.textContent = `cannot resolve ${body.side}: ${body.error}`;
      return;
    }
    if (r.status === 409) {
      operationStatus.textContent = "an operation is already running";
      return;
    }
    if (r.status === 202 && body.id) {
      operationStatus.textContent = "running…";
      watchOperation(body.id, payload.destination);
      return;
    }
    operationStatus.textContent = r.ok ? "ok" : `error ${r.status}: ${body.error ?? ""}`;
  } catch (err) {
    operationStatus.textContent = `error: ${err.message}`;
  }
}

// ── Run panel ───────────────────────────────────────────────────────────

const runStage = document.getElementById("run-stage");
const runProgress = document.getElementById("run-progress");
const runCounts = document.getElementById("run-counts");
const runLog = document.getElementById("run-log");
const runSummary = document.getElementById("run-summary");

const LOG_CAP = 500;

function watchOperation(id, destination) {
  operationRunning = true;
  // Capture the destination platform NOW, at start. The mid-run 401/403 hint
  // must name the platform this operation actually writes to — reading the live
  // radio at error time would name the wrong platform if the user flipped it
  // mid-run. We also disable the form inputs below as defence in depth.
  const opDestination = destination ?? selectedDestination();
  setFormDisabled(true);
  updateRunEnabled();
  runLog.hidden = false;
  runLog.innerHTML = "";
  runSummary.hidden = true;
  document.getElementById("run-copy-actions").hidden = true;
  const counts = { matched: 0, skipped: 0, written: 0, unmatched: 0, failed: 0 };
  let read = 0;
  let logCount = 0;
  // Full, untruncated log buffer for Copy log. The DOM is virtualized to the
  // last LOG_CAP lines for performance, but the copy must be complete — copying
  // the DOM would silently drop everything older than the cap.
  lastFullLog = [];

  const appendLog = (line) => {
    logCount++;
    lastFullLog.push(line);
    const div = document.createElement("div");
    div.className = "run-log-line";
    div.textContent = line;
    runLog.appendChild(div);
    // Virtualize: keep only the last LOG_CAP lines in the DOM.
    while (runLog.childElementCount > LOG_CAP) runLog.removeChild(runLog.firstChild);
  };
  const renderCounts = () => {
    runCounts.textContent = `read ${read} · matched ${counts.matched} · skipped ${counts.skipped} · written ${counts.written} · unmatched ${counts.unmatched} · failed ${counts.failed}`;
  };

  const es = new EventSource(`/api/operations/${id}/events`);
  es.addEventListener("stage", (e) => {
    const p = JSON.parse(e.data);
    const stage = p.stage ?? "";
    if (p.count !== undefined && stage === "source_read") read = p.count;
    runStage.textContent = `Stage: ${stage}${p.count !== undefined ? " (" + p.count + ")" : ""}`;
    renderCounts();
  });
  es.addEventListener("match", (e) => {
    const p = JSON.parse(e.data);
    counts.matched++;
    appendLog(`✓ match  ${p.title ?? p.source_id} → ${p.dest_id} (${p.tier}, ${p.from_cache ? "cached" : "live"})${p.revalidated ? " [revalidated]" : ""}`);
    renderCounts();
  });
  es.addEventListener("skip", (e) => {
    const p = JSON.parse(e.data);
    counts.skipped++;
    appendLog(`– skip   ${p.title ?? p.source_id} (${p.reason})`);
    renderCounts();
  });
  es.addEventListener("write", (e) => {
    const p = JSON.parse(e.data);
    counts.written++;
    appendLog(`▶ write  ${p.source_id} → ${p.dest_id}`);
    renderCounts();
  });
  es.addEventListener("unmatched", (e) => {
    const p = JSON.parse(e.data);
    counts.unmatched++;
    appendLog(`✗ unmatched  ${p.title ?? p.source_id} — ${p.artist ?? ""}`);
    renderCounts();
  });
  es.addEventListener("error", (e) => {
    if (!e.data) return;
    const p = JSON.parse(e.data);
    if (p.kind === "write_failed") {
      counts.failed++;
      // A 401/403 mid-run means the destination token/scope lapsed. Name the
      // exact fix (§11.1 actionable errors) instead of a bare status code.
      const fix =
        p.status === 401 || p.status === 403
          ? `  → reconnect ${opDestination === "spotify" ? "Spotify" : "Apple Music"} (auth lapsed), then re-run — already-written tracks will skip`
          : "";
      appendLog(`! failed  ${p.source_id} (status ${p.status})${fix}`);
    } else if (p.message) {
      appendLog(`! error  ${p.message}`);
    }
    renderCounts();
  });
  es.addEventListener("done", (e) => {
    es.close();
    operationRunning = false;
    setFormDisabled(false);
    updateRunEnabled();
    const p = JSON.parse(e.data);
    const s = p.summary ?? counts;
    runStage.textContent = `Done — ${p.status}`;
    runSummary.hidden = false;
    runSummary.textContent = `${p.status}: read ${s.read} · matched ${s.matched} · skipped ${s.skipped} · written ${s.written} · unmatched ${s.unmatched} · failed ${s.failed}` + (logCount > LOG_CAP ? `  (full ${logCount} events; on-screen shows last ${LOG_CAP}, Copy log copies all)` : "");
    operationStatus.textContent = `done (${p.status})`;
    // Stash for the copy buttons + reveal them.
    lastSummaryJson = JSON.stringify({ status: p.status, ...s }, null, 2);
    document.getElementById("run-copy-actions").hidden = false;
    loadPastOperations();
  });
  es.onerror = () => {
    es.close();
    if (!operationRunning) return; // already finished via the `done` event
    // The SSE connection dropped before a terminal `done` (server restart, the
    // network, a 5xx). Don't strand the user: surface what streamed so far and
    // let them copy the partial log. The server persisted every event, so the
    // operation also shows up (status `interrupted`) under Past operations.
    operationRunning = false;
    setFormDisabled(false);
    updateRunEnabled();
    runStage.textContent = "Disconnected — stream dropped before completion (operation may still be running server-side; see Past operations).";
    runSummary.hidden = false;
    runSummary.textContent = `disconnected — partial: read ${read} · matched ${counts.matched} · skipped ${counts.skipped} · written ${counts.written} · unmatched ${counts.unmatched} · failed ${counts.failed} (log below may be incomplete)`;
    operationStatus.textContent = "disconnected (partial)";
    lastSummaryJson = JSON.stringify({ status: "disconnected", partial: true, read, ...counts }, null, 2);
    document.getElementById("run-copy-actions").hidden = false;
    loadPastOperations();
  };
}

async function loadPastOperations() {
  try {
    const r = await fetch("/api/operations", { headers: { Accept: "application/json" } });
    const j = await r.json();
    const list = document.getElementById("past-ops-list");
    list.innerHTML = "";
    for (const op of j.operations ?? []) {
      const li = document.createElement("li");
      const summary = op.summary ? JSON.parse(op.summary) : null;
      const tag = op.status === "interrupted" ? " — re-run to resume (already-written items skip)" : "";
      li.textContent = `${op.source}→${op.destination}  ${op.status}${summary ? ` (${summary.written} written, ${summary.unmatched} unmatched)` : ""}${tag}`;
      list.appendChild(li);
    }
  } catch {
    /* ignore */
  }
}

document.getElementById("operation-form").addEventListener("submit", (e) => {
  e.preventDefault();
  submitOperation();
});

// Copy buttons (run-panel). Summary is held in lastSummaryJson; the log copies
// lastFullLog — the COMPLETE event list, not the virtualized DOM (which only
// keeps the last LOG_CAP lines), so Copy log never silently truncates.
// clipboard.writeText needs a secure context, but 127.0.0.1 counts as secure.
let lastSummaryJson = "";
let lastFullLog = [];
const copyStatus = document.getElementById("copy-status");
async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    copyStatus.textContent = `${label} copied`;
  } catch {
    copyStatus.textContent = "copy failed (clipboard blocked)";
  }
  setTimeout(() => (copyStatus.textContent = ""), 2000);
}
document.getElementById("copy-summary").addEventListener("click", () => copyText(lastSummaryJson, "summary"));
document.getElementById("copy-log").addEventListener("click", () => copyText(lastFullLog.join("\n"), `log (${lastFullLog.length} events)`));

// ── Disambiguation modal ────────────────────────────────────────────────

const modal = document.getElementById("disambig-modal");
const disambigPrompt = document.getElementById("disambig-prompt");
const disambigList = document.getElementById("disambig-candidates");
const disambigCreate = document.getElementById("disambig-create");
const disambigCancel = document.getElementById("disambig-cancel");

function openDisambig(side, candidates) {
  disambigPrompt.textContent = `The ${side} name matches ${candidates.length} playlists. Pick one:`;
  disambigList.innerHTML = "";
  for (const c of candidates) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `${c.name}${c.owner ? " — " + c.owner : ""}${c.track_count != null ? " (" + c.track_count + ")" : ""}`;
    btn.addEventListener("click", () => {
      modal.hidden = true;
      // Resubmit with the chosen id on the disambiguated side.
      if (side === "source") {
        srcSelect.value = `playlist:${c.id}`;
        srcInput.value = "";
      } else {
        dstSelect.value = `playlist:${c.id}`;
        dstInput.value = "";
      }
      submitOperation();
    });
    li.appendChild(btn);
    disambigList.appendChild(li);
  }
  // "Create new" only offered on the destination side.
  disambigCreate.hidden = side !== "destination";
  disambigCreate.onclick = () => {
    modal.hidden = true;
    submitOperation({ forceCreate: true });
  };
  modal.hidden = false;
}
disambigCancel.addEventListener("click", () => {
  modal.hidden = true;
});

// ── Gate wiring: keep run-enabled + catalog button in sync ──────────────

const origApplyGate = applyGate;
applyGate = function (gate) {
  origApplyGate(gate);
  gateOpen = gate.open;
  updateRunEnabled();
};

window.addEventListener("focus", () => {
  refreshAuthStatus();
  refreshGate();
});

refreshAuthStatus();
refreshGate();
loadCatalog();
loadPastOperations();

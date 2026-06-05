// Operations HTTP route (blueprint §11.2 + §9 disambiguation). Phase 6 wires
// the gate guard + target resolution + the ≥2-match 422 disambiguation. The
// actual transfer runner lands in Phase 7 — a fully-resolved request returns
// 501 (the 422 disambiguation is what "succeeds" past in the Phase 6 AC).

import { BodyTooLargeError, readJsonBody, route, sendJson, sendStatus } from "./server.js";
import { gateClosed } from "./routes_preflight.js";
import { findCatalogByName, normalizeName, type NameCandidate, type Platform } from "../ledger/catalogStore.js";
import { listMyPlaylists, playlistTrackCount } from "../clients/spotify.js";
import { listLibraryPlaylists } from "../clients/apple.js";
import { log } from "../util/log.js";
import { startOperation, subscribeOperation } from "../operation/runner.js";
import { getOperation, getOperationEvents, listOperations, OperationRunningConflict } from "../ledger/operationsStore.js";

type Side = "source" | "destination";

interface TargetInput {
  kind?: "playlist" | "liked" | "favorites";
  id?: string;
  /** Raw free-text (id / URL / name) when the user typed instead of picking. */
  query?: string;
  /** Destination-side "create new with this name anyway" — set by the
   * disambiguation modal to bypass an otherwise-ambiguous name (§9). */
  forceCreate?: boolean;
}

interface OperationBody {
  source?: Platform;
  destination?: Platform;
  sourceTarget?: TargetInput;
  destinationTarget?: TargetInput;
  rematch?: boolean;
}

type ResolvedTarget =
  | { kind: "liked" | "favorites" }
  | { kind: "playlist"; id: string }
  | { kind: "create"; name: string }; // destination-only: new playlist to create

type ResolveOutcome =
  | { ok: true; resolved: ResolvedTarget }
  | { ok: false; status: 422; body: { side: Side; error: string; candidates?: NameCandidate[] } };

// ── Free-text classification ─────────────────────────────────────────────
//
// A URL is an UNAMBIGUOUS id reference and resolves directly. A bare token
// that merely *looks* like an id is treated as an id ONLY when it doesn't
// also match a real playlist name — otherwise a playlist legitimately named
// like an id (a 22-char string, or one starting "p.") would silently skip §9
// disambiguation (finding #3). So: URL → id; else run name resolution first,
// and fall back to bare-id only on a 0-name result.

function parseSpotifyUrl(q: string): string | undefined {
  const m = q.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/) ?? q.match(/spotify:playlist:([A-Za-z0-9]+)/);
  return m?.[1];
}

function parseAppleUrl(q: string): string | undefined {
  const m = q.match(/music\.apple\.com\/[^/]+\/playlist\/[^/]*\/(p[l]?\.[A-Za-z0-9-]+)/);
  return m?.[1];
}

export function parseUrl(platform: Platform, q: string): string | undefined {
  return platform === "spotify" ? parseSpotifyUrl(q) : parseAppleUrl(q);
}

export function looksLikeBareId(platform: Platform, q: string): boolean {
  return platform === "spotify" ? /^[A-Za-z0-9]{22}$/.test(q) : /^p[l]?\.[A-Za-z0-9-]+$/.test(q);
}

/** Live-library name search (the §9 "AND the live library" half). Returns
 * NameCandidates from the platform's live playlist listing whose normalized
 * name equals `target`. On a live error, returns [] so resolution degrades to
 * the cache rather than failing the whole operation. */
async function liveNameMatches(platform: Platform, target: string): Promise<NameCandidate[]> {
  try {
    if (platform === "spotify") {
      const pls = await listMyPlaylists();
      return pls
        .filter((p) => normalizeName(p.name) === target)
        .map((p) => ({ id: p.id, name: p.name, owner: p.owner?.id ?? null, track_count: playlistTrackCount(p) ?? null, url: p.external_urls?.spotify ?? null }));
    }
    const pls = await listLibraryPlaylists();
    return pls
      .filter((p) => normalizeName(p.attributes.name) === target)
      .map((p) => ({ id: p.id, name: p.attributes.name, owner: null, track_count: null, url: null }));
  } catch (err) {
    log.warn("operations.live_name_search_failed", { platform, message: (err as Error).message });
    return [];
  }
}

/** Union cache + live matches, deduped by id (cache wins on collision so the
 * richer cached track_count is kept). */
function unionMatches(cache: NameCandidate[], live: NameCandidate[]): NameCandidate[] {
  const byId = new Map<string, NameCandidate>();
  for (const c of live) byId.set(c.id, c);
  for (const c of cache) byId.set(c.id, c); // cache overrides
  return [...byId.values()];
}

/** Resolve one side's target per §9. */
async function resolveTarget(platform: Platform, side: Side, t: TargetInput | undefined): Promise<ResolveOutcome> {
  if (!t) {
    return { ok: false, status: 422, body: { side, error: "missing_target" } };
  }
  if (t.kind === "liked" || t.kind === "favorites") {
    // Bind kind ↔ platform: Spotify has "liked", Apple has "favorites"
    // (finding #4). Reject the mismatch rather than silently passing a bogus
    // target downstream.
    const expected = platform === "spotify" ? "liked" : "favorites";
    if (t.kind !== expected) {
      return { ok: false, status: 422, body: { side, error: "invalid_target_kind_for_platform" } };
    }
    return { ok: true, resolved: { kind: t.kind } };
  }
  // Explicit id from the dropdown.
  if (t.id) {
    return { ok: true, resolved: { kind: "playlist", id: t.id } };
  }
  const q = (t.query ?? "").trim();
  if (q.length === 0) {
    return { ok: false, status: 422, body: { side, error: "missing_target" } };
  }
  // A URL is an unambiguous id reference.
  const urlId = parseUrl(platform, q);
  if (urlId) {
    return { ok: true, resolved: { kind: "playlist", id: urlId } };
  }
  // Destination-side explicit "create new with this name anyway" (modal).
  if (side === "destination" && t.forceCreate) {
    return { ok: true, resolved: { kind: "create", name: q } };
  }
  // Free-text NAME → §9 disambiguation across the catalog cache AND the live
  // library (union, deduped). The live half is the safety net for a stale or
  // empty cache — without it a real playlist could be missed and (on the
  // destination side) duplicated.
  const target = normalizeName(q);
  const matches = unionMatches(findCatalogByName(platform, q), await liveNameMatches(platform, target));
  if (matches.length === 0) {
    // Nothing matched by name. A bare id-looking token now resolves as an id.
    if (looksLikeBareId(platform, q)) {
      return { ok: true, resolved: { kind: "playlist", id: q } };
    }
    if (side === "source") {
      // Can't transfer FROM a playlist that doesn't exist.
      return { ok: false, status: 422, body: { side, error: "source_playlist_not_found" } };
    }
    return { ok: true, resolved: { kind: "create", name: q } };
  }
  if (matches.length === 1) {
    return { ok: true, resolved: { kind: "playlist", id: matches[0]!.id } };
  }
  // ≥2 → caller must disambiguate.
  return { ok: false, status: 422, body: { side, error: "ambiguous_name", candidates: matches } };
}

export function registerOperationsRoutes(): void {
  route("POST", "/api/operations", async ({ req, res }) => {
    if (gateClosed(res)) return;

    let body: OperationBody;
    try {
      body = await readJsonBody<OperationBody>(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw err;
      sendStatus(res, 400, "invalid_json");
      return;
    }

    const { source, destination } = body;
    if (source !== "spotify" && source !== "apple") {
      sendStatus(res, 400, "invalid_source");
      return;
    }
    if (destination !== "spotify" && destination !== "apple") {
      sendStatus(res, 400, "invalid_destination");
      return;
    }
    if (source === destination) {
      sendStatus(res, 400, "source_equals_destination");
      return;
    }

    const srcRes = await resolveTarget(source, "source", body.sourceTarget);
    if (!srcRes.ok) {
      sendJson(res, 422, srcRes.body);
      return;
    }
    const dstRes = await resolveTarget(destination, "destination", body.destinationTarget);
    if (!dstRes.ok) {
      sendJson(res, 422, dstRes.body);
      return;
    }

    // Fully resolved → start the additive transfer (Phase 7).
    try {
      const handle = startOperation({
        source,
        destination,
        sourceTarget: srcRes.resolved,
        destinationTarget: dstRes.resolved,
        rematch: body.rematch === true,
      });
      void handle.done.catch(() => undefined);
      sendJson(res, 202, { id: handle.id });
    } catch (err) {
      if (err instanceof OperationRunningConflict) {
        sendStatus(res, 409, "operation_already_running");
        return;
      }
      log.error("operations.start_failed", { message: (err as Error).message });
      sendStatus(res, 500, "operation_start_failed");
    }
  });

  route("GET", "/api/operations", ({ res }) => {
    sendJson(res, 200, { operations: listOperations() });
  });

  route("GET", "/api/operations/:id", ({ res, params }) => {
    const op = getOperation(params["id"]!);
    if (!op) {
      sendStatus(res, 404, "operation_not_found");
      return;
    }
    sendJson(res, 200, { operation: op, events: getOperationEvents(op.id) });
  });

  route("GET", "/api/operations/:id/events", ({ req, res, params }) => {
    const id = params["id"]!;
    const op = getOperation(id);
    if (!op) {
      sendStatus(res, 404, "operation_not_found");
      return;
    }
    const lastEventId = Number(req.headers["last-event-id"] ?? 0) || 0;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });

    const sent = new Set<number>();
    let closed = false;
    const send = (seq: number, type: string, payload: unknown): void => {
      if (closed || seq <= lastEventId || sent.has(seq)) return;
      sent.add(seq);
      res.write(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
      if (type === "done" || type === "interrupted") {
        closed = true;
        res.end();
      }
    };

    const emitter = subscribeOperation(id);
    const onEvent = (e: { seq: number; type: string; payload: unknown }): void => send(e.seq, e.type, e.payload);
    if (emitter) emitter.on("event", onEvent);

    // Replay persisted events with seq > Last-Event-ID (synchronous; no live
    // event can interleave before this returns).
    for (const e of getOperationEvents(id, lastEventId)) {
      send(e.seq, e.type, e.payload ? JSON.parse(e.payload) : {});
    }
    // If the run already finished, close after replaying the terminal event.
    const fresh = getOperation(id);
    if (fresh && fresh.status !== "running" && !closed) {
      closed = true;
      res.end();
    }

    req.on("close", () => {
      closed = true;
      if (emitter) emitter.off("event", onEvent);
    });
  });
}

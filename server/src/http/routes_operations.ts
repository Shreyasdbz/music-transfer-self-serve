// Operations HTTP route (blueprint §11.2 + §9 disambiguation). Phase 6 wires
// the gate guard + target resolution + the ≥2-match 422 disambiguation. The
// actual transfer runner lands in Phase 7 — a fully-resolved request returns
// 501 (the 422 disambiguation is what "succeeds" past in the Phase 6 AC).

import type { Hono } from "hono";
import { err, readJson } from "./respond.js";
import { sse } from "./sse.js";
import { gateBlocked } from "./routes_preflight.js";
import {
  findCatalogByName,
  normalizeName,
  type NameCandidate,
  type Platform,
} from "../ledger/catalogStore.js";
import { listMyPlaylists, playlistTrackCount } from "../clients/spotify.js";
import { listLibraryPlaylists } from "../clients/apple.js";
import { log } from "../util/log.js";
import { startOperation, subscribeOperation } from "../operation/runner.js";
import {
  getOperation,
  getOperationEvents,
  listOperations,
  OperationRunningConflict,
} from "../ledger/operationsStore.js";
import { getProvider, hasProvider } from "../providers/registry.js";

type Side = "source" | "destination";

/** A provider id usable as a transfer source/destination: registered AND
 * available (a "Coming soon" placeholder is registered but available:false).
 * Type guard so the resolved id narrows to a defined Platform downstream. */
function transferable(id: Platform | undefined): id is Platform {
  return !!id && hasProvider(id) && getProvider(id).available !== false;
}

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
  const m =
    q.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/) ??
    q.match(/spotify:playlist:([A-Za-z0-9]+)/);
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
        .map((p) => ({
          id: p.id,
          name: p.name,
          owner: p.owner?.id ?? null,
          track_count: playlistTrackCount(p) ?? null,
          url: p.external_urls?.spotify ?? null,
        }));
    }
    const pls = await listLibraryPlaylists();
    return pls
      .filter((p) => normalizeName(p.attributes.name) === target)
      .map((p) => ({
        id: p.id,
        name: p.attributes.name,
        owner: null,
        track_count: null,
        url: null,
      }));
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
async function resolveTarget(
  platform: Platform,
  side: Side,
  t: TargetInput | undefined,
): Promise<ResolveOutcome> {
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
  const matches = unionMatches(
    findCatalogByName(platform, q),
    await liveNameMatches(platform, target),
  );
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

export function registerOperationsRoutes(app: Hono): void {
  app.post("/api/operations", async (c) => {
    const blocked = gateBlocked(c);
    if (blocked) return blocked;

    let body: OperationBody;
    try {
      body = await readJson<OperationBody>(c);
    } catch {
      return err(c, 400, "invalid_json");
    }

    const { source, destination } = body;
    // Registry-driven: accept any registered, AVAILABLE provider (a not-yet-
    // functional placeholder like the YouTube "Coming soon" provider has
    // available:false and is rejected here, so it can never be a transfer end).
    if (!transferable(source)) return err(c, 400, "invalid_source");
    if (!transferable(destination)) return err(c, 400, "invalid_destination");
    if (source === destination) return err(c, 400, "source_equals_destination");

    const srcRes = await resolveTarget(source, "source", body.sourceTarget);
    if (!srcRes.ok) return c.json(srcRes.body, 422);
    const dstRes = await resolveTarget(destination, "destination", body.destinationTarget);
    if (!dstRes.ok) return c.json(dstRes.body, 422);

    // Fully resolved → start the additive transfer.
    try {
      const handle = startOperation({
        source,
        destination,
        sourceTarget: srcRes.resolved,
        destinationTarget: dstRes.resolved,
        rematch: body.rematch === true,
      });
      void handle.done.catch(() => undefined);
      return c.json({ id: handle.id }, 202);
    } catch (e) {
      if (e instanceof OperationRunningConflict) return err(c, 409, "operation_already_running");
      log.error("operations.start_failed", { message: (e as Error).message });
      return err(c, 500, "operation_start_failed");
    }
  });

  app.get("/api/operations", (c) => c.json({ operations: listOperations() }));

  app.get("/api/operations/:id", (c) => {
    const op = getOperation(c.req.param("id"));
    if (!op) return err(c, 404, "operation_not_found");
    return c.json({ operation: op, events: getOperationEvents(op.id) });
  });

  app.get("/api/operations/:id/events", (c) => {
    const id = c.req.param("id");
    const op = getOperation(id);
    if (!op) return err(c, 404, "operation_not_found");

    const lastEventId = Number(c.req.header("last-event-id") ?? 0) || 0;
    return sse(c, (api) => {
      const sent = new Set<number>();
      const send = (seq: number, type: string, payload: unknown): void => {
        if (seq <= lastEventId || sent.has(seq)) return;
        sent.add(seq);
        api.write({ id: String(seq), event: type, data: JSON.stringify(payload) });
        if (type === "done" || type === "interrupted") api.done();
      };

      const emitter = subscribeOperation(id);
      const onEvent = (e: { seq: number; type: string; payload: unknown }): void =>
        send(e.seq, e.type, e.payload);
      if (emitter) {
        emitter.on("event", onEvent);
        api.onClose(() => emitter.off("event", onEvent));
      }

      // Replay persisted events with seq > Last-Event-ID (synchronous; no live
      // event can interleave before this returns).
      for (const e of getOperationEvents(id, lastEventId)) {
        send(e.seq, e.type, e.payload ? JSON.parse(e.payload) : {});
      }
      // If the run already finished, close after replaying the terminal event.
      const fresh = getOperation(id);
      if (fresh && fresh.status !== "running") api.done();
    });
  });
}

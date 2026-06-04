// Operations HTTP route (blueprint §11.2 + §9 disambiguation). Phase 6 wires
// the gate guard + target resolution + the ≥2-match 422 disambiguation. The
// actual transfer runner lands in Phase 7 — a fully-resolved request returns
// 501 (the 422 disambiguation is what "succeeds" past in the Phase 6 AC).

import { BodyTooLargeError, readJsonBody, route, sendJson, sendStatus } from "./server.js";
import { gateClosed } from "./routes_preflight.js";
import { findCatalogByName, type NameCandidate, type Platform } from "../ledger/catalogStore.js";

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

function parseSpotifyId(q: string): string | undefined {
  const url = q.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/) ?? q.match(/spotify:playlist:([A-Za-z0-9]+)/);
  if (url) return url[1];
  if (/^[A-Za-z0-9]{22}$/.test(q)) return q; // bare Spotify playlist id
  return undefined;
}

function parseAppleId(q: string): string | undefined {
  const url = q.match(/music\.apple\.com\/[^/]+\/playlist\/[^/]*\/(p[l]?\.[A-Za-z0-9-]+)/);
  if (url) return url[1];
  if (/^p[l]?\.[A-Za-z0-9-]+$/.test(q)) return q; // bare Apple library/catalog playlist id
  return undefined;
}

function parseRawId(platform: Platform, q: string): string | undefined {
  return platform === "spotify" ? parseSpotifyId(q) : parseAppleId(q);
}

/** Resolve one side's target per §9. */
function resolveTarget(platform: Platform, side: Side, t: TargetInput | undefined): ResolveOutcome {
  if (!t) {
    return { ok: false, status: 422, body: { side, error: "missing_target" } };
  }
  if (t.kind === "liked" || t.kind === "favorites") {
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
  // A URL or raw id resolves directly.
  const rawId = parseRawId(platform, q);
  if (rawId) {
    return { ok: true, resolved: { kind: "playlist", id: rawId } };
  }
  // Destination-side explicit "create new with this name anyway" (modal).
  if (side === "destination" && t.forceCreate) {
    return { ok: true, resolved: { kind: "create", name: q } };
  }
  // Otherwise treat as a free-text NAME → §9 disambiguation against the cache.
  const matches = findCatalogByName(platform, q);
  if (matches.length === 0) {
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

    const srcRes = resolveTarget(source, "source", body.sourceTarget);
    if (!srcRes.ok) {
      sendJson(res, 422, srcRes.body);
      return;
    }
    const dstRes = resolveTarget(destination, "destination", body.destinationTarget);
    if (!dstRes.ok) {
      sendJson(res, 422, dstRes.body);
      return;
    }

    // Fully resolved — the transfer runner is Phase 7.
    sendJson(res, 501, {
      error: "not_implemented",
      detail: "Operation runner lands in Phase 7",
      resolved: { source: srcRes.resolved, destination: dstRes.resolved, rematch: body.rematch === true },
    });
  });
}

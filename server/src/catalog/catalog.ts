// On-demand catalog refresh (blueprint §11.1 panel 3 + §11.2).
//
// Fetches the user's playlists per connected platform and caches them in the
// `catalog` table so the Operation form can offer a dropdown. Incremental
// (one platform at a time, playlist-by-playlist) and cancellable: a cancel
// stops further fetches and KEEPS rows already written (skips stale-removal).
//
// Only one refresh runs at a time. Progress streams over a single in-process
// EventEmitter consumed by the /api/catalog/events SSE handler.

import { EventEmitter } from "node:events";
import { log, redact } from "../util/log.js";
import { getConnectedState as spotifyConnected } from "../auth/spotify.js";
import { getConnectedState as appleConnected } from "../auth/apple.js";
import { listMyPlaylists, getSavedTracksTotal, playlistTrackCount } from "../clients/spotify.js";
import { listLibraryPlaylists } from "../clients/apple.js";
import {
  deleteStaleCatalogRows,
  upsertCatalogRow,
  LIKED_SENTINEL,
  FAVORITES_SENTINEL,
  type Platform,
} from "../ledger/catalogStore.js";

export interface CatalogEvent {
  readonly seq: number;
  readonly type: "platform_start" | "playlist" | "platform_done" | "cancelled" | "complete" | "error";
  readonly platform?: Platform;
  readonly name?: string;
  readonly index?: number;
  readonly total?: number;
  readonly count?: number;
  readonly message?: string;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function subscribeCatalog(): EventEmitter {
  return emitter;
}

interface RefreshState {
  running: boolean;
  cancelled: boolean;
  seq: number;
}
let state: RefreshState = { running: false, cancelled: false, seq: 0 };

export function isCatalogRefreshRunning(): boolean {
  return state.running;
}

/** Request cancellation of the in-flight refresh. Returns true if one was
 * running. Rows already written stay; stale-removal is skipped. */
export function cancelCatalogRefresh(): boolean {
  if (!state.running) return false;
  state.cancelled = true;
  return true;
}

function emit(evt: Omit<CatalogEvent, "seq">): void {
  state.seq += 1;
  emitter.emit("event", { seq: state.seq, ...evt });
}

async function refreshSpotify(startedAt: string): Promise<void> {
  emit({ type: "platform_start", platform: "spotify" });
  const playlists = await listMyPlaylists();
  let written = 0;
  for (let i = 0; i < playlists.length; i++) {
    if (state.cancelled) return;
    const p = playlists[i]!;
    upsertCatalogRow({
      platform: "spotify",
      kind: "playlist",
      external_id: p.id,
      name: p.name,
      owner: p.owner?.id ?? null,
      track_count: playlistTrackCount(p) ?? null,
      url: p.external_urls?.spotify ?? null,
      fetched_at: startedAt,
    });
    written++;
    emit({ type: "playlist", platform: "spotify", name: p.name, index: i + 1, total: playlists.length });
  }
  // Liked Songs singleton (cheap total count).
  if (!state.cancelled) {
    let likedTotal: number | null = null;
    try {
      likedTotal = await getSavedTracksTotal();
    } catch {
      likedTotal = null;
    }
    upsertCatalogRow({
      platform: "spotify",
      kind: "liked",
      external_id: LIKED_SENTINEL,
      name: "Liked Songs",
      owner: null,
      track_count: likedTotal,
      url: null,
      fetched_at: startedAt,
    });
  }
  if (!state.cancelled) deleteStaleCatalogRows("spotify", startedAt);
  emit({ type: "platform_done", platform: "spotify", count: written });
}

async function refreshApple(startedAt: string): Promise<void> {
  emit({ type: "platform_start", platform: "apple" });
  const playlists = await listLibraryPlaylists();
  let written = 0;
  for (let i = 0; i < playlists.length; i++) {
    if (state.cancelled) return;
    const p = playlists[i]!;
    upsertCatalogRow({
      platform: "apple",
      kind: "playlist",
      external_id: p.id,
      name: p.attributes.name,
      owner: null, // library playlists are the user's own; Apple exposes no curator id
      track_count: null, // Apple's library-playlists listing doesn't include a track count
      url: null,
      fetched_at: startedAt,
    });
    written++;
    emit({ type: "playlist", platform: "apple", name: p.attributes.name, index: i + 1, total: playlists.length });
  }
  // Favorites singleton. Apple has no cheap "favorites count"; store the row
  // so it appears in the dropdown, count unknown.
  if (!state.cancelled) {
    upsertCatalogRow({
      platform: "apple",
      kind: "favorites",
      external_id: FAVORITES_SENTINEL,
      name: "Favorite Songs",
      owner: null,
      track_count: null,
      url: null,
      fetched_at: startedAt,
    });
  }
  if (!state.cancelled) deleteStaleCatalogRows("apple", startedAt);
  emit({ type: "platform_done", platform: "apple", count: written });
}

export interface CatalogRefreshHandle {
  readonly done: Promise<void>;
}

export class CatalogRefreshRunningError extends Error {
  constructor() {
    super("a catalog refresh is already running");
    this.name = "CatalogRefreshRunningError";
  }
}

/** Start an incremental refresh of all connected platforms. Throws
 * CatalogRefreshRunningError if one is already in flight. */
export function startCatalogRefresh(): CatalogRefreshHandle {
  if (state.running) throw new CatalogRefreshRunningError();
  state = { running: true, cancelled: false, seq: 0 };
  const startedAt = new Date().toISOString();

  const done = (async (): Promise<void> => {
    try {
      if (spotifyConnected().connected && !state.cancelled) {
        try {
          await refreshSpotify(startedAt);
        } catch (err) {
          // Redact before the message hits the SSE wire (§12 — every SSE
          // payload must be redaction-safe; a non-JSON 2xx body would
          // otherwise surface raw via a SyntaxError message).
          emit({ type: "error", platform: "spotify", message: String(redact((err as Error).message)) });
          log.warn("catalog.spotify_refresh_failed", { message: (err as Error).message });
        }
      }
      if (appleConnected().connected && !state.cancelled) {
        try {
          await refreshApple(startedAt);
        } catch (err) {
          emit({ type: "error", platform: "apple", message: String(redact((err as Error).message)) });
          log.warn("catalog.apple_refresh_failed", { message: (err as Error).message });
        }
      }
      emit(state.cancelled ? { type: "cancelled" } : { type: "complete" });
    } finally {
      state.running = false;
    }
  })();

  return { done };
}

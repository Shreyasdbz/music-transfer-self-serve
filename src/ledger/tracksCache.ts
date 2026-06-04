// Ledger-backed match cache for the `tracks` table (blueprint §9).
//
// On every successful Tier-1 / Tier-2 match the matcher upserts a row keyed
// on the canonical identity key (ISRC when valid, else the fuzzy fallback).
// Re-runs of the same Operation hit the cache before re-issuing live API
// calls. The Operation form's "Rematch" toggle deletes cached rows for the
// source items before resolution (blueprint §12.5).

import { openLedger } from "./db.js";

export interface CachedTrack {
  readonly identity_key: string;
  readonly isrc: string | undefined;
  readonly norm_title: string | undefined;
  readonly norm_artist: string | undefined;
  readonly duration_ms: number | undefined;
  readonly spotify_id: string | undefined;
  readonly apple_catalog_id: string | undefined;
  readonly apple_library_id: string | undefined;
  readonly match_tier: "isrc" | "search" | "unmatched";
  readonly confidence: number;
  readonly updated_at: string;
}

const COLS =
  "identity_key, isrc, norm_title, norm_artist, duration_ms, spotify_id, apple_catalog_id, apple_library_id, match_tier, confidence, updated_at";

/** Fetch a cached row by identity key. Returns undefined on miss. */
export function getCachedTrack(identityKey: string): CachedTrack | undefined {
  const db = openLedger();
  const row = db.prepare(`SELECT ${COLS} FROM tracks WHERE identity_key = ?`).get(identityKey) as
    | CachedTrack
    | undefined;
  return row ?? undefined;
}

/** Upsert a row; later runs overwrite earlier mappings for the same key. */
export function putCachedTrack(row: CachedTrack): void {
  const db = openLedger();
  db.prepare(
    `INSERT INTO tracks (${COLS}) VALUES (
       @identity_key, @isrc, @norm_title, @norm_artist, @duration_ms,
       @spotify_id, @apple_catalog_id, @apple_library_id, @match_tier,
       @confidence, @updated_at
     )
     ON CONFLICT(identity_key) DO UPDATE SET
       isrc            = excluded.isrc,
       norm_title      = excluded.norm_title,
       norm_artist     = excluded.norm_artist,
       duration_ms     = excluded.duration_ms,
       spotify_id      = COALESCE(excluded.spotify_id, tracks.spotify_id),
       apple_catalog_id= COALESCE(excluded.apple_catalog_id, tracks.apple_catalog_id),
       apple_library_id= COALESCE(excluded.apple_library_id, tracks.apple_library_id),
       match_tier      = excluded.match_tier,
       confidence      = excluded.confidence,
       updated_at      = excluded.updated_at`,
  ).run({
    identity_key: row.identity_key,
    isrc: row.isrc ?? null,
    norm_title: row.norm_title ?? null,
    norm_artist: row.norm_artist ?? null,
    duration_ms: row.duration_ms ?? null,
    spotify_id: row.spotify_id ?? null,
    apple_catalog_id: row.apple_catalog_id ?? null,
    apple_library_id: row.apple_library_id ?? null,
    match_tier: row.match_tier,
    confidence: row.confidence,
    updated_at: row.updated_at,
  });
}

/** Delete a single cached entry (used by the Phase 7 Rematch path). */
export function deleteCachedTrack(identityKey: string): void {
  openLedger().prepare("DELETE FROM tracks WHERE identity_key = ?").run(identityKey);
}

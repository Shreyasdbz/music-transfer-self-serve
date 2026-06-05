// Ledger-backed match cache (blueprint §9; generalized in v2).
//
// The `tracks` table holds the canonical identity + match metadata; the
// per-track destination write-ids live in `track_provider_ids` (one row per
// (identity_key, provider)), which replaces the v1 spotify_id/apple_catalog_id/
// apple_library_id columns. The matcher upserts the identity row plus a provider
// ref for the source and destination sides on every resolved match; re-runs hit
// the cache before re-issuing live API calls. The "Rematch" toggle deletes a
// cached row before resolution (§12.5) — the provider refs cascade away with it.

import { openLedger } from "./db.js";

/** Canonical identity + match metadata. The destination write-ids are stored
 * separately (see get/putProviderRef) so the cache generalizes to any number
 * of providers. */
export interface CachedTrack {
  readonly identity_key: string;
  readonly isrc: string | undefined;
  readonly norm_title: string | undefined;
  readonly norm_artist: string | undefined;
  readonly duration_ms: number | undefined;
  readonly match_tier: "isrc" | "search" | "unmatched";
  readonly confidence: number;
  readonly updated_at: string;
}

const IDENTITY_COLS = "identity_key, isrc, norm_title, norm_artist, duration_ms, match_tier, confidence, updated_at";

/** The write-id kind used for matching (Spotify track id / Apple catalog id /
 * YouTube video id). Apple's separate library id is stored as 'library' and is
 * not used by the matcher. */
const DEFAULT_KIND = "default";

/** Fetch the cached identity/match row by key. Returns undefined on miss. */
export function getCachedTrack(identityKey: string): CachedTrack | undefined {
  const db = openLedger();
  const row = db.prepare(`SELECT ${IDENTITY_COLS} FROM tracks WHERE identity_key = ?`).get(identityKey) as
    | CachedTrack
    | undefined;
  return row ?? undefined;
}

/** Upsert the identity/match row. Later runs overwrite earlier match metadata
 * for the same key (provider refs are upserted separately). */
export function putCachedTrack(row: CachedTrack): void {
  const db = openLedger();
  db.prepare(
    `INSERT INTO tracks (${IDENTITY_COLS}) VALUES (
       @identity_key, @isrc, @norm_title, @norm_artist, @duration_ms,
       @match_tier, @confidence, @updated_at
     )
     ON CONFLICT(identity_key) DO UPDATE SET
       isrc        = excluded.isrc,
       norm_title  = excluded.norm_title,
       norm_artist = excluded.norm_artist,
       duration_ms = excluded.duration_ms,
       match_tier  = excluded.match_tier,
       confidence  = excluded.confidence,
       updated_at  = excluded.updated_at`,
  ).run({
    identity_key: row.identity_key,
    isrc: row.isrc ?? null,
    norm_title: row.norm_title ?? null,
    norm_artist: row.norm_artist ?? null,
    duration_ms: row.duration_ms ?? null,
    match_tier: row.match_tier,
    confidence: row.confidence,
    updated_at: row.updated_at,
  });
}

/** Upsert a provider write-id for a track. The identity row must already exist
 * (FK). `provider_kind` defaults to the matching write-id; pass 'library' for
 * Apple's separate library id. */
export function putProviderRef(
  identityKey: string,
  providerId: string,
  providerRef: string,
  providerKind: string = DEFAULT_KIND,
): void {
  openLedger()
    .prepare(
      `INSERT INTO track_provider_ids (identity_key, provider_id, provider_kind, provider_ref)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(identity_key, provider_id, provider_kind)
         DO UPDATE SET provider_ref = excluded.provider_ref`,
    )
    .run(identityKey, providerId, providerKind, providerRef);
}

/** Read a provider's cached write-id for a track. Returns undefined on miss. */
export function getProviderRef(
  identityKey: string,
  providerId: string,
  providerKind: string = DEFAULT_KIND,
): string | undefined {
  const row = openLedger()
    .prepare(
      `SELECT provider_ref FROM track_provider_ids
       WHERE identity_key = ? AND provider_id = ? AND provider_kind = ?`,
    )
    .get(identityKey, providerId, providerKind) as { provider_ref: string } | undefined;
  return row?.provider_ref;
}

/** Delete a cached entry (used by the Rematch path). The track_provider_ids rows
 * cascade away via the FK (ON DELETE CASCADE). */
export function deleteCachedTrack(identityKey: string): void {
  openLedger().prepare("DELETE FROM tracks WHERE identity_key = ?").run(identityKey);
}

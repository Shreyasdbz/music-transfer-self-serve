// Catalog table queries (blueprint §9). The catalog caches the user's
// playlists per platform so the Operation form can offer a dropdown instead
// of asking for raw ids.
//
// kind ∈ 'playlist' | 'liked' | 'favorites'. For the liked/favorites
// singletons, external_id uses the sentinel '__liked__' / '__favorites__'
// (never empty/NULL — both break the composite PK).

import { openLedger } from "./db.js";

/** A provider id (registry-driven). Was the closed `"spotify" | "apple"` union;
 * widened to a provider id so catalog code loops over the registry instead of
 * branching on a fixed platform set (matches `operation/types.ts`). */
export type Platform = string;
export type CatalogKind = "playlist" | "liked" | "favorites";

export const LIKED_SENTINEL = "__liked__";
export const FAVORITES_SENTINEL = "__favorites__";

export interface CatalogRow {
  readonly platform: Platform;
  readonly kind: CatalogKind;
  readonly external_id: string;
  readonly name: string | null;
  readonly owner: string | null;
  readonly track_count: number | null;
  readonly url: string | null;
  readonly fetched_at: string | null;
}

const COLS = "platform, kind, external_id, name, owner, track_count, url, fetched_at";

export function upsertCatalogRow(row: CatalogRow): void {
  openLedger()
    .prepare(
      `INSERT INTO catalog (${COLS}) VALUES
        (@platform, @kind, @external_id, @name, @owner, @track_count, @url, @fetched_at)
       ON CONFLICT(platform, kind, external_id) DO UPDATE SET
         name = excluded.name,
         owner = excluded.owner,
         track_count = excluded.track_count,
         url = excluded.url,
         fetched_at = excluded.fetched_at`,
    )
    .run({
      platform: row.platform,
      kind: row.kind,
      external_id: row.external_id,
      name: row.name,
      owner: row.owner,
      track_count: row.track_count,
      url: row.url,
      fetched_at: row.fetched_at,
    });
}

export function getCatalog(): CatalogRow[] {
  return openLedger()
    .prepare(`SELECT ${COLS} FROM catalog ORDER BY platform, kind, name`)
    .all() as CatalogRow[];
}

export function getCatalogByPlatform(platform: Platform): CatalogRow[] {
  return openLedger()
    .prepare(`SELECT ${COLS} FROM catalog WHERE platform = ? ORDER BY kind, name`)
    .all(platform) as CatalogRow[];
}

/** Most recent fetched_at for a platform (the "last refreshed" timestamp). */
export function lastFetchedAt(platform: Platform): string | null {
  const row = openLedger()
    .prepare(`SELECT MAX(fetched_at) AS t FROM catalog WHERE platform = ?`)
    .get(platform) as { t: string | null } | undefined;
  return row?.t ?? null;
}

/** Delete a platform's catalog rows whose fetched_at is older than `since`
 * (stale-removal after a COMPLETE refresh — playlists deleted upstream since
 * the last refresh). Skipped on a cancelled refresh so partial results stay. */
export function deleteStaleCatalogRows(platform: Platform, since: string): void {
  openLedger()
    .prepare(`DELETE FROM catalog WHERE platform = ? AND (fetched_at IS NULL OR fetched_at < ?)`)
    .run(platform, since);
}

export function clearCatalogPlatform(platform: Platform): void {
  openLedger().prepare(`DELETE FROM catalog WHERE platform = ?`).run(platform);
}

// ── Name resolution (§9 disambiguation) ──────────────────────────────────

/** §9 name normalization: trim + collapse internal whitespace + case-fold.
 * Deliberately lighter than match/identity.normalize (no diacritic/punctuation
 * stripping) — playlist names are matched as the user typed them. */
export function normalizeName(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface NameCandidate {
  readonly id: string;
  readonly name: string;
  readonly owner: string | null;
  readonly track_count: number | null;
  readonly url: string | null;
}

/** Find cached playlists on `platform` whose normalized name matches `typed`.
 * Used for the 0/1/≥2 free-text-name disambiguation. Only `kind='playlist'`
 * rows participate (Liked/Favorites are selected explicitly, not by name). */
export function findCatalogByName(platform: Platform, typed: string): NameCandidate[] {
  const target = normalizeName(typed);
  if (target.length === 0) return [];
  const rows = openLedger()
    .prepare(
      `SELECT external_id, name, owner, track_count, url FROM catalog WHERE platform = ? AND kind = 'playlist'`,
    )
    .all(platform) as {
    external_id: string;
    name: string | null;
    owner: string | null;
    track_count: number | null;
    url: string | null;
  }[];
  return rows
    .filter((r) => r.name !== null && normalizeName(r.name) === target)
    .map((r) => ({
      id: r.external_id,
      name: r.name as string,
      owner: r.owner,
      track_count: r.track_count,
      url: r.url,
    }));
}

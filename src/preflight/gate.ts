// Gate state + refresh-aware auto-invalidation (blueprint §11.1).
//
// The gate guards Catalog refresh and Operation runs. It is OPEN only when the
// latest passing preflight is recent (24h) and no auth/scope failure has been
// detected since. `util/http.ts` reports persistent auth failures here via the
// sink installed by `installAuthFailureSink`.

import { randomUUID } from "node:crypto";
import { setAuthFailureSink } from "../util/http.js";
import { log } from "../util/log.js";
import {
  computeGateState,
  hasInvalidationSinceLastPass,
  insertInvalidation,
  type GateState,
  type PreflightTrigger,
} from "../ledger/preflightStore.js";

export function getGateState(): GateState {
  return computeGateState();
}

/** Insert an auto-invalidation marker so the gate closes until the human
 * re-runs Check permissions.
 *
 * Debounced: if the gate is ALREADY closed by an invalidation since the last
 * pass, skip the insert. The first failure on a bad session closes the gate;
 * every subsequent failing request in the same burst (paginated reads, a
 * fan-out catalog refresh) would otherwise insert a redundant row. One
 * invalidation is enough — the rest are pure ledger churn. */
export function invalidateGate(trigger: "auto-401" | "auto-403-scope"): void {
  if (hasInvalidationSinceLastPass()) return;
  insertInvalidation(randomUUID(), trigger as PreflightTrigger, new Date().toISOString());
  log.warn("preflight.gate_auto_invalidated", { trigger });
}

/**
 * Classify an HTTP outcome for auto-invalidation purposes.
 *
 *   - 401 → 'auth'  (caller passes status=401 only AFTER a refresh+retry has
 *                    already failed; the http layer enforces that)
 *   - 403 whose body indicates a scope/permission problem → 'scope'
 *   - 403 that looks like a rate-limit → 'none' (do not invalidate)
 *   - anything else → 'none'
 *
 * Pure + exported so the decision is unit-tested directly.
 */
export function classifyAuthFailure(status: number, bodyText: string): "none" | "auth" | "scope" {
  if (status === 401) return "auth";
  if (status === 403) {
    const body = bodyText.toLowerCase();
    // Rate-limit 403s (or anything mentioning rate limiting) never invalidate.
    if (/rate.?limit|too many requests|quota exceeded/.test(body)) return "none";
    // Scope / permission problems do. Kept deliberately narrow — broad
    // substrings like "unauthorized" or "access token" matched generic 403
    // bodies and could wrongly invalidate the gate on an unrelated failure.
    if (/scope|insufficient|not authorized|permission/.test(body)) {
      return "scope";
    }
    return "none";
  }
  return "none";
}

/** Wire `util/http.ts`'s auth-failure sink to the gate. Called once at server
 * startup. The sink receives the trigger string and inserts the invalidation
 * row. */
export function installAuthFailureSink(): void {
  setAuthFailureSink((trigger) => {
    invalidateGate(trigger);
  });
}

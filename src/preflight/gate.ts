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
  insertInvalidation,
  type GateState,
  type PreflightTrigger,
} from "../ledger/preflightStore.js";

export function getGateState(): GateState {
  return computeGateState();
}

/** Insert an auto-invalidation marker so the gate closes until the human
 * re-runs Check permissions. */
export function invalidateGate(trigger: "auto-401" | "auto-403-scope"): void {
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
    // Scope / permission problems do.
    if (/scope|insufficient|permission|not authorized|unauthorized|forbidden access|access token/.test(body)) {
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

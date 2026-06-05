// Shared Operation types (blueprint §8 / §9). Kept separate so the runner and
// the HTTP routes both depend on this, not on each other.

/** A platform id. Was the closed union `"spotify" | "apple"`; widened to a
 * `ProviderId` (string) in v2 so a third provider needs no edit here. Routes
 * still validate against the registered providers. */
export type Platform = string;

export type ResolvedTarget =
  | { kind: "liked" | "favorites" }
  | { kind: "playlist"; id: string }
  | { kind: "create"; name: string };

export interface OperationSpec {
  readonly source: Platform;
  readonly destination: Platform;
  readonly sourceTarget: ResolvedTarget;
  readonly destinationTarget: ResolvedTarget;
  readonly rematch: boolean;
}

/** Event types persisted to `operation_events` and streamed over SSE (§9). */
export type OperationEventType =
  | "stage"
  | "match"
  | "skip"
  | "write"
  | "unmatched"
  | "error"
  | "done"
  | "interrupted";

export interface OperationSummary {
  read: number;
  matched: number;
  skipped: number;
  written: number;
  unmatched: number;
  failed: number;
}

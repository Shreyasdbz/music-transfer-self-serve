<!-- @format -->

# PROGRESS.md — build log

The running log of how this project was built and evolved.
The agent appends an entry at the start and end of each phase (see `blueprint.md` §13).
Spec _changes_ go in the blueprint's Amendment log (§15); _build activity_ goes here.
Keep entries factual and terse.

---

## Format

```
### YYYY-MM-DD — Phase N: <name>
- Start: <what's about to be done>
- Decisions: <any choice made, deps added + why>
- Result: <acceptance criteria pass/fail, what's left>
```

---

## Log

### (seed) — Phase 0 not yet started

- Repo contains the ready-to-go scaffolding (blueprint, CLAUDE, README, .gitignore,
  .env.example, sync.config.example.json, this file).
  Agent begins at Phase 0 per `blueprint.md` §13.

### 2026-06-03 — Pivot: CLI bidirectional sync → local web UI for one-time Operations

- Human-directed scope change before any code was written.
  Authored as `blueprint.md` §15 amendment of the same date; rewrote §1, §3, §8, §9, §10,
  §11, §13, §14 to match.
- Tool's unit of work is now the **Operation**:
  `{source, destination, sourceTarget, destinationTarget}`, additive-only, run on-demand
  from the UI's Run button with live SSE status. The Spotify ↔ Apple bidirectional
  reconciliation model with `sync_pairs`/`baseline` three-way merge is deferred.
- Removed `sync.config.example.json` (operations are ad-hoc; pair config no longer exists).
  Removed `reports/` from `.gitignore` (no reports directory in v1; unmatched surfaces in
  the UI and in `operation_events`).
- Repo state heading into Phase 0: `blueprint.md`, `CLAUDE.md`, `README.md` (needs update
  for new UI surface — pending in Phase 0), `PROGRESS.md`, `.gitignore`, `.env`, and
  `.env.example` (still TBD — Phase 0). No source code yet.
- Next: Phase 0 scaffold per the revised §13.

### 2026-06-03 — Spec amendment: Permissions preflight gate

- Human-directed addition before any code was written.
  Authored as `blueprint.md` §15 amendment of the same date; updated §1 in-scope bullet,
  §3 (added `src/preflight/`), §9 (added `preflight_runs` + `preflight_checks` tables),
  §11 (added Permissions panel + endpoints + gating policy + `doctor` sharing the
  orchestrator), §13 (inserted new Phase 5; renumbered the rest), and §14.
- Behavior: 11-check sequence (env, both tokens, Spotify scopes, sample reads on each side,
  ISRC lookup, Apple delete-probe). Streams pass/warn/fail via SSE.
  Catalog refresh + Operation runs are disabled UI-side and 412-refused server-side until
  the latest preflight `passed`. Auto-invalidation on any downstream 401/403.
  No time-window expiry — re-check is cheap.
- The CLI `doctor` is now a thin surface over the same `preflight/runner.ts`;
  a CLI pass and a UI pass are interchangeable for gating.
- Phase plan grew from 8 → 9 phases.
  Phase 5 is now Permissions preflight; Catalog/UI is 6; Operation runner is 7;
  Polish is 8; Publish is 9.
- Next: still Phase 0 scaffold (no code yet); the preflight work lands in the new Phase 5.

### 2026-06-03 — Spec amendment: Preflight design tightened (validation pass)

- Human asked to deeply validate and resolve five open concerns I had raised against the
  previous preflight amendment, then commit and push.
  Authored as `blueprint.md` §15 amendment of the same date; updated §1, §6.2, §9, §11.1,
  §13 (Phase 5 AC rewritten), and §14.
- Resolutions:
  1. **Gate has a 24h soft expiry** in addition to the failure-based invalidation.
     Catches overnight drift (revoked Spotify auth, expired MUT) at the door rather than
     mid-Operation. Re-checks are cheap.
  2. **`apple_delete_probe` removed from v1 preflight.**
     v1 deletes nothing, so the probe is deferred along with removals;
     §6.2 now states this explicitly. Check list is 10, not 11.
  3. **Auto-invalidation is refresh-aware.**
     `util/http.ts` attempts one token refresh / dev-token re-sign + retry on 401;
     only the second 401 (or a 403 whose body indicates a scope problem, not rate-limit)
     writes an `invalidated` row.
     Trigger values: `'auto-401'` or `'auto-403-scope'`.
     Rate-limit 403s and transient 401s recovered by refresh do not invalidate.
  4. **`spotify_scopes` reads the persisted scope list from `data/tokens.json`**
     (captured from the OAuth `scope` response field).
     Spotify has no public token-introspection endpoint for PKCE clients —
     inventing one would violate the truthfulness invariant.
     The blueprint now calls this out so a future agent doesn't go hunting.
  5. **Ten checks remain fine-grained, presented in three UI groups**
     (Environment / Spotify / Apple).
     Env runs first; Spotify and Apple groups run in parallel;
     intra-group skips when a prerequisite fails.
- Phase plan unchanged (still 9 phases).
  Phase 5 AC rewritten as six numbered subcriteria so the agent has concrete pass/fail
  targets (e.g. "backdate `finished_at` to >24h → gate closes →
  POST /api/catalog/refresh returns 412").
- Next: Phase 0 scaffold per §13. After this docs commit lands, building begins.

### 2026-06-03 — Spec amendment: 6-persona validation pass → 8 amendments

- Human-directed. Ran multi-persona adversarial workflow `wf_cc3ea7a4-e8f`
  (security / API truthfulness / UX / architecture / coherence / build-readiness),
  6 personas in parallel, each finding individually verified by a refute-by-default
  adversarial verifier. Raw: 65 findings → 28 verified real → 0 blockers, 2 high,
  12 medium, 14 low. API-truthfulness persona's 9 findings all dropped by verifier
  (no live-doc drift surfaced).
- Resolved every verified finding with concrete spec edits across blueprint, README,
  and CLAUDE.md:
  1. **Fixed `SPOTIFY_REDIRECT_URI`** in §4 (was `/callback`, now
     `/auth/spotify/callback`); Phase 2 AC now asserts byte-equality across all four
     reference locations. This was the guaranteed first-run failure flagged by 3
     personas independently.
  2. **New §11.0 "Local-server security model"**: 127.0.0.1-only bind,
     Host/Origin validation on all routes, per-server-start CSRF token in HTML
     consumed via `X-CSRF-Token`, OAuth `state` + PKCE `code_verifier` in in-memory
     store with 10min TTL, Apple popup nonce binding `/start` to `/callback`,
     **short-lived (10min) developer token** for the browser so the 180-day JWT
     never leaves the server. Phase 1/2/3 ACs updated to land these in sequence.
  3. **Expanded §12 redaction list** (developerToken, OAuth code/access_token/
     refresh_token/state/code_verifier/nonce in bodies + query strings,
     BEGIN PRIVATE KEY pattern, configured Team/Key ID values, Set-Cookie/Cookie
     headers); **per-check `preflight_checks.detail` allow-lists** spelled out
     (`apple_dev_token` reports `alg`/`exp_days_remaining`/`signed` — never
     `iss`/`kid` since those equal Team ID / Key ID); **file permissions** 0600 on
     `.p8`, `tokens.json`, `ledger.sqlite*`; 0700 on `secrets/` and `data/`;
     verified at startup.
  4. **§9 + §12.5 hardening**: partial unique indexes
     `WHERE status='running'` on `operations` and `preflight_runs` (DB-level
     enforcement of "one at a time"); `finished_at` indexes for gate-query
     performance; `NOT NULL` constraints; `__liked__`/`__favorites__` sentinels for
     `catalog.external_id`; new `interrupted` status; **startup reconciliation
     sweep** marks stranded `running` rows as `interrupted`; **resume soundness
     union** uses `operation_events.write` rows (canonical) alongside destination
     read, eliminating the eventual-consistency duplicate-append risk.
  5. **Rematch fully wired** through §11.1 (Advanced toggle), §11.2 (POST body
     field), §12.5 (deletes cached `tracks` rows for source items before
     resolution), Phase 7 AC subcriterion (verified via `match` event with
     `from_cache: false`). Also: auto-revalidation when a cached target id 404s.
  6. **ISRC fixture sourcing for `apple_isrc_lookup`** specified in §11.1: derive
     at runtime from the resolved storefront's top chart (`/v1/catalog/{sf}/charts`),
     avoiding hardcoded fixtures that drift across storefronts and over time.
  7. **Free-text duplicate-name disambiguation** in §9: 0 matches → create (dest only);
     1 → auto-resolve; ≥2 → server returns 422 with candidate list, UI prompts
     disambiguation modal; Phase 6 AC covers the modal.
  8. **Coherence sweep + folded-in low-impact fixes**: §3 `sync.sqlite` →
     `ledger.sqlite`; §9 dropped `'warn'` status; README "Apple capability probes"
     line corrected; CLAUDE.md idempotency test moved Phase 6 → Phase 7; `.DS_Store`
     added to CLAUDE.md gitignore checklist. Also folded in SSE `Last-Event-ID`
     reconnect protocol (against `operation_events.seq`), UI poll-on-focus for gate
     state, event-log virtualization (cap at last 500 events + aggregate counters),
     popup-failure UX (10s grace), mid-Operation gate-invalidation behavior (current
     Operation continues, next blocked), WAL/foreign_keys/synchronous PRAGMAs,
     schema_version semantics, Phase 0 `npm run build` semantics.
- §14 done criteria add: §11.0 security model in place; crash-recovery (no orphaned
  `running` rows after restart); `doctor`-UI gate-state visibility.
- Phase plan unchanged (still 9 phases). Phase 1 grew to also include the §11.0
  security framework scaffold (CSRF, Origin/Host middleware, network bind).
- Spec is now at **READY TO BUILD** per the validation report's verdict bar; no
  known gaps that would cause first-run failure or guaranteed mid-build amendments.
- Next: Phase 0 scaffold per §13.

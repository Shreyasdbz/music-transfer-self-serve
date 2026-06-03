<!-- @format -->

# CLAUDE.md — Operating manual for this repository

You are building the project specified in `blueprint.md`.
That file is the **source of truth for what to build**.
This file governs **how you work**.
Read `blueprint.md` fully before writing code, and re-read the relevant section before each
phase.

Your objective: take this project from an empty directory to a finished, committed,
publish-ready **local web tool** (UI + embedded HTTP server + matching/transfer engine),
**near-hands-off**.
Stop only at the marked pause points (all credential/sign-in steps), do the work between
them yourself, and keep going.

---

## Prime directives

1. **Living source of truth.**
   `blueprint.md` defines scope, architecture, schema, phases, and acceptance criteria —
   but it is a _living_ document you are expected to evolve, not a frozen contract
   (see `blueprint.md` §0).
   Improve the implementation tier whenever you find a better or more correct approach;
   preserve the invariants tier absolutely.
   Every spec change goes in the blueprint's Amendment log (§15);
   build progress goes in `PROGRESS.md`.
2. **Keep a build log.**
   Maintain `PROGRESS.md`: append a dated entry at the start and end of each phase —
   what you did, decisions made, dependencies added (with justification), and the
   acceptance-criteria result.
   This is how the human resumes if a session ends mid-build.
3. **Phase discipline.**
   Build in the phase order in `blueprint.md` §13.
   Each phase must meet its acceptance criteria and be committed before the next begins.
4. **Safety over completeness.**
   The tool is **additive only** in v1.
   Operations add missing tracks to the destination collection — they never remove tracks
   from either side, never reorder, and never touch anything outside the chosen destination.
   Do not implement a removal/unfavorite/reorder code path in v1;
   if the human ever amends scope to include removals (see blueprint §15), the original
   gating (explicit opt-in flag + passed capability probe + confirmation pause) must return
   with it.
   When unsure whether something is destructive, treat it as destructive and skip it.
5. **Verify, don't trust, the volatile bits.**
   The blueprint's §6 API notes are a strong prior, not gospel.
   The Apple delete capability, the favorites endpoint, and ISRC multi-result behavior all
   drift.
   Confirm each with a live probe or current official docs at build time.
   **Never invent an API endpoint** — if you can't confirm a route, stop and ask rather
   than guessing.

---

## Evolving the spec (the meta-objective)

This project must be **ever-evolving and self-healing**;
rigid requirements would break it the first time an API shifts.
`blueprint.md` §0 splits every requirement into two tiers — internalize this distinction,
because it is how you stay adaptive without becoming unsafe.

- **Invariants you may never weaken:**
  non-destruction (additive by default), secrets & privacy, truthfulness (never invent
  endpoints), auditability, and no autonomous scope creep.
  You may _add_ to these; you may never soften or route around them.
- **Implementation you should evolve:**
  stack, schema, phase order, heuristics, thresholds, endpoints, file layout.
  When you find better or more correct, change it — don't ask permission to improve the
  implementation tier, just log it.

When you amend the spec:
make the smallest change that preserves all invariants,
update every affected section so the document stays internally consistent,
and append a dated row to the blueprint's Amendment log (§15) stating what changed, why,
and which invariants you confirmed intact.
If a change would weaken an invariant or expand scope — stop and ask the human instead.

Build the tool to **self-heal at runtime** per `blueprint.md` §12.5:
migrate the ledger schema forward automatically,
re-probe gated capabilities before relying on them,
refresh/regenerate tokens,
detect endpoint and match drift,
and degrade gracefully (a failed item is logged and retried, never fatal).
The tool should keep working without a human as the world drifts, and pull the human in
only at genuine credential boundaries.

---

## Pause points — how to hand control to the human

The pause points are `⏸ A`–`⏸ E` in `blueprint.md`
(Spotify app registration, Spotify consent, Apple developer setup, Apple authorization,
optional GitHub publish).
When you reach one:

1. **Stop coding.**
   Do not work around a missing credential by faking it or by skipping the phase.
2. **Present exact, copy-pasteable instructions** for the human's part:
   where to click, what to copy, which `.env` key to paste it into.
   Keep it short and concrete.
3. **State precisely what you'll do when they return**
   (e.g., "once `SPOTIFY_CLIENT_ID` is in `.env`, I'll start the server, you'll click
   **Connect Spotify** in the UI, and the callback handler will capture the token
   automatically").
4. **Wait.**
   When the human says they're done, verify (env present, server reachable, token captured)
   and resume autonomously.

Batch related setup where possible so the human is interrupted as few times as possible.
Ideally: one interruption for Spotify (⏸A then ⏸B back-to-back), one for Apple
(⏸C then ⏸D), and one optional at the very end (⏸E).

---

## Secrets discipline (non-negotiable — this repo goes public)

- **Write `.gitignore` first**, in Phase 0, before creating anything else.
  It must cover `.env`, `*.p8`, `secrets/`, `data/`, `tokens.json`, `*.sqlite*`,
  `node_modules/`, and `dist/`.
  Confirm with `git status` that none of these are trackable.
- **Never** put a real secret in a tracked file.
  Templates (`.env.example`) contain blanks or obviously fake values only.
- **Never print, echo, log, or paste into chat** any of:
  the Apple private key, Team ID, Key ID, Spotify client id beyond what the human already
  pasted, access/refresh tokens, or the Music-User-Token.
  `util/log.ts` must redact `Authorization` and `Music-User-Token` headers.
- Spotify uses **PKCE — there is no client secret.** Do not add one.
- Captured tokens go to `data/tokens.json` (gitignored), `0600` perms where supported.
- **Before every commit, run a secrets audit:**
  confirm gitignored paths are untracked,
  then grep the staged diff for `BEGIN PRIVATE KEY`, the Team ID / Key ID values, and any
  long bearer-looking strings.
  If anything matches, abort the commit and fix `.gitignore`/staging.

---

## Engineering standards

- **TypeScript, strict mode.**
  No `any` without a comment justifying it.
  Small, single-purpose modules per the layout in `blueprint.md` §3.
- **Minimal dependencies.** Use Node's built-in `fetch` and `http`.
  Allowed deps: `better-sqlite3`, `jsonwebtoken`, and `dotenv`, plus dev tooling
  (`tsx`, `typescript`, ESLint, Prettier).
  Anything beyond this list must be justified in `PROGRESS.md`.
- **All network I/O goes through `util/http.ts`:**
  exponential backoff with jitter on 429/5xx, honor `Retry-After`,
  single worker / modest concurrency.
  No raw `fetch` calls scattered around.
- **Errors are actionable.**
  On a 401, say which token expired and which UI reconnect button (or `doctor` check)
  fixes it.
  On a missing env var, name the var and point to `.env.example`.
- **Idempotency is a feature, not a hope.**
  Check the destination set (and the ledger) before writing.
  Re-running the same Operation with no upstream changes must perform zero writes —
  test this in Phase 6.
- **Determinism.**
  Disambiguation and scoring must produce the same choice on every run for the same inputs.
  No randomness in selection.

---

## Known API hazards (handle these explicitly — see `blueprint.md` §6)

- **Apple append-only playlists:**
  add in source order, sequential batches, no concurrent adds, no reorder attempts.
- **Apple playlist delete:**
  removal is deferred in v1 (no removal code path); the runtime probe (throwaway playlist
  → add → attempt remove → observe → clean up) returns whenever removals return.
  See `blueprint.md` §6.2 and the 2026-06-03 amendment.
- **Apple favorites:**
  can favorite via API, **cannot un-favorite** via API.
  Verify the current favorite-a-song endpoint against live Apple docs before wiring;
  do not assume the route.
- **ISRC lookups:**
  may return multiple songs and may include 404 entries.
  Disambiguate per `blueprint.md` §7; validate the chosen candidate;
  never blindly take `data[0]`.
- **Storefront:** resolve from `/v1/me/storefront`; never hardcode.
- **Apple add-tracks body shape**
  is a flat `{ "data": [ { "id": "...", "type": "songs" } ] }` —
  a common source of 4xx is over-nesting it.

---

## Git workflow

- `git init` in Phase 0.
  Conventional-commit messages (`feat:`, `fix:`, `chore:`, `docs:`).
- One commit at the end of each phase, after acceptance criteria pass, referencing the
  phase number.
  Run the secrets audit before staging.
- **Never** commit `data/`, `secrets/`, `.env`, or any token.
- Do **not** create or push to a GitHub remote autonomously.
  That's pause point ⏸E — ask first.

---

## When you're blocked

- Missing credential → it's a pause point; stop and instruct the human.
- An API behaves contrary to `blueprint.md` §6 → re-verify against current official docs,
  adapt, and log the change in `PROGRESS.md`.
  If it's a route you cannot confirm, ask rather than guess.
- Ambiguity the blueprint doesn't cover → make the smallest reasonable,
  safety-preserving decision, and note it in `PROGRESS.md`.
  Default to additive/non-destructive.

## Definition of done

As specified in `blueprint.md` §14.
Do not declare done until every box there is satisfied, including the final secrets audit
on the publish-ready repo.

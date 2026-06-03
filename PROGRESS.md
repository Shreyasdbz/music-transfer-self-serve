<!-- @format -->

# PROGRESS.md — build log

The running log of how this project was built and evolved. The agent appends an entry at the start
and end of each phase (see `blueprint.md` §13). Spec _changes_ go in the blueprint's Amendment log
(§15); _build activity_ goes here. Keep entries factual and terse.

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

- Repo contains the ready-to-go scaffolding (blueprint, CLAUDE, README, .gitignore, .env.example,
  sync.config.example.json, this file). Agent begins at Phase 0 per `blueprint.md` §13.

# GSD Intake — turning these findings into planned, tracked work

This review is analysis, not planning state. To act on it without breaking GSD's traceability, feed the findings into the `/gsd:*` flow rather than hand-editing `.planning/`. Two properties of this review make that clean:

- **Stable finding IDs** (`DI-01`, `FE-03`, …) → use them as **requirement IDs** in each phase, so coverage is traceable finding → phase → commit.
- **Every finding has a "Done when" line** → those are the phase **success / verification criteria** verbatim. `/gsd:verify-phase` and `/gsd:add-tests` have something concrete to check (a failing test that must pass), not "did we refactor X."

> GSD-enforcement note: the review docs live in `review/` (a deliverable), so writing them didn't need a GSD entry point. **Mutating `.planning/` does** — use the commands below; don't hand-edit ROADMAP.md/phases.

---

## Routing by finding profile

| Profile | GSD entry point | Findings |
|---------|-----------------|----------|
| S · sonnet · fully specified, atomic | `/gsd:quick` (one per finding) | OPS-01, OPS-03, BE-05, BE-06, FE-05, SY-05, BE-09, BE-10 |
| Correctness bug, fix known, **needs failing test first** | `/gsd:quick` with test-first, or a small phase | DI-01, DI-02 |
| Opus · design judgment · multi-file arc | `/gsd:discuss-phase` → `/gsd:plan-phase` → `/gsd:execute-phase` | FE-07→DI-03→SY-02 (conflict safety); BE-01+BE-02 (lifecycle); FE-01/02/04/06 (frontend shared layer); BE-03 |
| Contract / type-safety, mechanical but spec-touching | `/gsd:quick` or rolled into the nearest phase | SY-04, BE-04, BE-11, BE-07, BE-08, OPS-04, OPS-05 |
| Security (see `06-security.md`) | criticals → `/gsd:debug` now; rest → `/gsd:secure-phase` | (pending audit) |
| Belongs to v1.2 redesign | `/gsd:phase` edit on the v1.2 milestone | FE-08 (→ v1.2 phase 5); callouts-architecture check (→ v1.2 phase 7) |
| LOW / opportunistic | `/gsd:capture` → backlog; `/gsd:review-backlog` to promote | remaining LOW |

Durability (`07`) and performance (`08`) findings route by the same rules once those audits land — the external-edit watcher (if confirmed missing) is likely a HIGH large enough to be its own phase.

---

## Proposed milestone shape: **v1.3 "Hardening"**, sequenced AFTER v1.2

> **Milestone-ready doc:** the full, current milestone context lives in [`MILESTONE-hardening.md`](./MILESTONE-hardening.md) — that's the file to feed `/gsd:new-milestone` once v1.2 wraps. The table below is the historical intake sketch, updated for what's shipped.
>
> **Version correction:** v1.0 and v1.1 already shipped and v1.2 is in progress, so this is **v1.3**, not the "v1.1" this sketch originally proposed. The old "prereq for v1.2" framing is obsolete — v1.2 is already underway; Hardening comes after it.

Progress legend: ✅ shipped this session (as `/gsd:quick`) · ⬜ remaining.

| Phase | Closes (requirement IDs) | Status |
|-------|--------------------------|--------|
| **H1 — CI & doc correctness** | ✅ OPS-01 · ⬜ OPS-06 (docs), CLAUDE.md staleness | mostly done → OPS-06 folds into H-DURABILITY |
| **H2 — Index integrity** | ✅ DI-01, ✅ DI-02 | **DONE** |
| **H3 — Conflict safety** | FE-07 → DI-03 → DUR-02 → SY-02 → DI-04 (+ DUR-01/04/05) | ⬜ → **H-CONFLICT** (flagship) |
| **H4 — Write-surface parity** | ✅ SY-01, ✅ SY-05 · ⬜ SY-03, SY-04, BE-09, BE-11 | ⬜ → **H-PARITY** |
| **H5 — Lifecycle hardening** | BE-01, BE-02, DI-05, OPS-02, BE-05, BE-06, BE-08, OPS-04 | ⬜ → **H-LIFECYCLE** |
| **H6 — Frontend shared layer** | FE-01, FE-02, FE-04, FE-06, FE-05, FE-03 (+ PERF-01/02) | ⬜ → **H-FRONTEND** |
| **H7 — Security remediation** | SEC-01..08 | ⬜ → **H-SEC** (do first — drive-by exfil) |

The remaining ⬜ work is re-grouped and sequenced in [`MILESTONE-hardening.md`](./MILESTONE-hardening.md) (7 phases: H-SEC, H-CONFLICT, H-PARITY, H-LIFECYCLE, H-FRONTEND, H-BACKEND, H-DURABILITY), which also folds in the backend-hygiene (BE-03/04/07/10, DUR-06) and performance (PERF-03/04) findings this sketch omitted.

Fold into **v1.2** (not Hardening): FE-08, the callouts-architecture check, and re-read the "judged fine" notes on SettingsDialog/TabStrip (v1.2 reworks both regardless).

---

## Command sequence (from here to executable roadmap)

1. **Immediate correctness/safety** — `/gsd:quick` for OPS-01 (CI first — gives every later phase a net), then DI-01, DI-02. Each: reference the finding ID and its review file; the "Done when" line is the acceptance test.
2. **Open the milestone** — `/gsd:new-milestone` "v1.1 Hardening", then `/gsd:phase` to add H2–H7 with the requirement IDs above as their requirements.
3. **Per opus phase** — `/gsd:discuss-phase` (resolve the design judgment the finding flags, e.g. BE-02's reopen-old-vs-error-page, OPS-04's config precedence, OPS-05's 0700/0755 decision) → `/gsd:plan-phase` → `/gsd:execute-phase`.
4. **Security** — when `06-security.md` lands, `/gsd:debug` any CRITICAL immediately; route the rest through `/gsd:secure-phase`.
5. **Backlog** — `/gsd:capture` the LOW items so they're tracked but not blocking; `/gsd:review-backlog` to promote when touching neighboring code.
6. **Alternative bulk intake** — `/gsd:import` can ingest this `review/` folder as external plans with conflict detection against existing ADRs/decisions, if you'd rather GSD reconcile it in one pass than hand-route.

## Decisions to surface at discuss-phase (owner calls, flagged in findings)

- **OPS-05** — `.jasper` permissions: 0700 vs 0755 (lifecycle vs doctor contradict; lifecycle's sync-tool argument is stronger).
- **OPS-04** — config precedence: wire listen-port to `app.json.ServerPort` vs delete the dead app-level fields.
- **BE-02** — failed-swap recovery: reopen previous vault vs serve an error page.
- **DI-04** — versioning: explicit opaque `etag` field vs nanosecond-mtime everywhere.
- **OPS-03** — dev port: make `port.sh` real vs simplify to `JASPER_PORT`.

## Relationship to GSD's built-in code-review

`/gsd:code-review` produces its own `REVIEW.md` and `--fix` applies **atomic** fixes via `gsd-code-fixer`. This review is a deeper, architectural superset: the S/sonnet items (H1, and the `/gsd:quick` rows) are fixer-shaped, but the opus-L arcs (H3, H5, H6) are **phase-shaped** and must not go through `--fix` — they need discuss/plan/verify. Don't reformat the arcs to force them into the atomic-fix path.

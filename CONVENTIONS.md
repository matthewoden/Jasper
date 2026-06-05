# Conventions

Project-level process rules. Source of truth for the `## Conventions` block in CLAUDE.md (regenerated via GSD; see the `<!-- GSD:conventions-start source:CONVENTIONS.md -->` markers there).

## Build & embed pipeline

- **Always use `make build` for any binary that will be tested or shipped.** The Makefile's `build` target performs `cp -R frontend/dist/. backend/internal/static/dist/` between `npm run build` and `go build`. Skipping that copy step bakes the previous frontend bundle into the binary via `//go:embed all:dist`, producing a stale UI in production. Plan 05.5-15 hit this and lost a full UAT walkthrough — see `.planning/phases/05.5-sidebar-editor-shell-polish/05.5-15-SUMMARY.md` "What Got Caught Mid-Walk".
- For any plan or task instruction that says `npm run build && go build`, treat it as a defect — replace with `make build`.

## Verification policy: E2E before human UAT

- **Every gap-closure plan that fixes a user-facing bug MUST include a Playwright E2E scenario that exercises the fix against `bin/jasper`** (live binary), not just a vitest unit test. The unit tests are not load-bearing for production-only regressions — Phase 5.5 had multiple bugs that passed 593 unit tests but failed in real browsers (UX-09 reflow, UX-12 create-at-level, UX-13 Cmd-click).
- Land the E2E test BEFORE asking the user for human UAT on the affected scenario. The user's time is the most expensive thing in the loop; don't burn it on stale binaries or already-broken features.
- E2E scenarios live in `frontend/e2e/phase{N}-uat.spec.ts` (or `phase{N}_{M}-uat.spec.ts` for sub-phases like 5.5).
- Smoke run E2E against `make build`, not `npm run build && go build`.

## Halt-if-inconclusive gate (gap-closure pattern)

- Gap-closure plans that pair `investigate → fix` tasks should set `autonomous: true` with an explicit **HALT-IF-INCONCLUSIVE GATE** in the fix task's `<action>`: re-read the investigation file's `## Recommended Fix` section; if it does not name a single file:line + concrete change, STOP and surface for human triage rather than speculatively patching. Pattern shipped in Plan 05.5-14 (toolbar regression — caught a contract drift) and Plan 05.5-17 (Bugs A/B/C).

## Investigation-first for "behaves wrong" reports (Phase 7 retro, 2026-05-16)

- For any UAT item phrased as "X doesn't work / shows wrong / behaves weird", **stand up the dev server (preview_start) or use `/gsd-debug` BEFORE writing the fix plan.** Backend behavior is cheap to verify (one HTTP probe); frontend behavior shows in `preview_logs` + `preview_console_logs`. Plan 07-38 skipped this for N2 and burned a round shipping a "make it debuggable" patch instead of finding the real cause (turned out to be a deliberate backend `.md` refusal the user thought was a frontend bug).
- The investigation can be inline (5-10 min, captured in the SUMMARY) or a dedicated `07-NN-INVESTIGATION.md` artifact (the formal pattern that closes with COMPLETE / HALT status; see Plans 07-31, 07-35 for the template).
- Cost calibration: 15 min reproducing in the dev server saves on average ~1 full plan-round of speculative work. The N2 / N11 issues in Phase 7 round-4 cost ~24 commits of churn that could have been ~8 if the dev-server probe had happened first.

## AskUserQuestion before drafting for ambiguous UAT items (Phase 7 retro, 2026-05-16)

- For any UAT item phrased without a direction ("alignment is off", "save indicator placement wrong", "search doesn't feel right"), **use AskUserQuestion BEFORE drafting the fix plan**, not after the fix lands. Phase 7 N5 alignment (which-piece-moves) and N9 SaveIndicator (StatusBar-vs-TopBar) each cost one extra plan-round because I made an interpretation rather than asking.
- Good questions cluster 2-4 ambiguities into one prompt — multiple-question dispatches are cheaper than back-and-forth.
- Save the answers in the corresponding `07-HUMAN-UAT-{N}.md` capture doc under a "User clarifications (AskUserQuestion)" section so future readers see the decision trail.

## Soft-accept vs hard-accept UAT discipline (Phase 7 retro, 2026-05-16)

- A user's "accepted" in a same-day UAT walkthrough is a **soft-accept**: they tried the change once and didn't immediately reject it.
- A **hard-accept** requires the item to survive a 24-48h period of real use without being flagged in a subsequent UAT.
- For UI/UX items especially, design plans that depend on a previous "accepted" item should explicitly note `soft-accept (UAT-N, YYYY-MM-DD)` in their `depends_on:` rationale so the dependency is auditable. Phase 7 N10 was soft-accepted in UAT-3, then reversed in UAT-5 — the soft/hard distinction would have surfaced that risk earlier.
- Do not delete code that was reversed under a soft-accept — orphan it (see Orphaned code rule below).

## Plan-vs-investigation consistency (Phase 7 retro, 2026-05-16)

- When an investigation reaches a different conclusion than the plan's example code/YAML, **either amend the plan file or write investigation-first plans**. Plan 07-32a's example showed `/files/{path}` but the investigation correctly chose `/files?path=` (query-param); the plan stayed stale and three downstream executors had to be briefed about the deviation each time.
- Acceptable patterns:
  - **Amend-the-plan**: update the plan's `<interfaces>`/`<action>` blocks after the investigation completes; commit the amendment before dispatching the GREEN executor.
  - **Investigation-first plan**: skip the example code in the plan entirely (no `/files/{path}` straw-man); link to the investigation doc as the single source of truth and let GREEN read the recommended fix verbatim.
- The HALT-IF-INCONCLUSIVE gate (see above) covers the case where the investigation didn't reach a conclusion; this rule covers the case where it DID, but the plan didn't catch up.

## Orphaned code is a design signal (Phase 7 retro, 2026-05-16)

- Before adding a new component or refactoring an existing surface, **grep for components that already do the thing being asked for**. If they exist and have no consumers, ask "why were these orphaned?" before re-deriving the original design the long way around.
- Phase 7 example: `SearchInputBar.tsx` + `SearchResultsList.tsx` sat orphaned across 4 plans (07-18 → 07-39) before Plan 07-39 remounted them. If the orphan had been noticed earlier, Plans 07-33 + 07-38's "merge title-fuzzy + FTS5 in palette" arc could have been skipped — the user's mental model (separate switcher vs separate search) matched the original architecture the orphaned components implemented.
- Useful greps: `git log --diff-filter=D -- '<file>'` (was it deleted and re-added?), `grep -r 'import.*ComponentName' --include='*.tsx'` (any consumers?), `grep -l 'data-testid="some-id"' src/` (test fixtures that reference unreachable surfaces?).

## Plan sizing: bundle vs split (Phase 7 retro, 2026-05-16)

- **Bundle plans** (one plan, N sequenced tasks, one executor) for small, well-scoped fixes where each task is < 30 min and the failure surface is localized. Used successfully in Plan 07-36 (3-task bundle) and Plan 07-37 (4-task bundle).
- **Split plans** (separate plan files, optionally separate executors) for anything with investigation, design ambiguity, or cross-cutting refactor. Bundles save planning overhead at the cost of resume complexity when an agent crashes mid-flight (Plan 07-38 hit a 500 mid-Task-1; recovery worked but represented risk).
- Rule of thumb: if any task in the bundle would benefit from its own `07-NN-INVESTIGATION.md`, split it out.

## Worktree vs in-main execution default (Phase 7 retro, 2026-05-16)

- **Default to in-main (no worktree)** for sequential single-executor work. The cherry-pick overhead from worktree isolation exceeds the parallelism gain when ≤2 plans run concurrently. The "lost worktree merge" recovery commits (`chore: recover lost worktree merge ...`) document a recurring failure mode.
- **Use worktree isolation** only when:
  - ≥3 plans run in parallel AND touch disjoint code surfaces, OR
  - The work might destabilize the main repo temporarily (e.g., a risky refactor with multiple WIP iterations), OR
  - You explicitly want to compare two implementation approaches side-by-side.
- After worktree work completes, cherry-pick into main and verify caches are clean (`go clean -cache && golangci-lint cache clean`) to avoid stale-path lint errors from the abandoned worktree's source.

## UAT capture, decision logging, and the deferred-items backlog

- Every UAT round produces a `07-HUMAN-UAT-{N}.md` capture doc in the phase directory. The doc has three required sections:
  1. **Findings (verbatim)** — the user's raw feedback, unedited.
  2. **Triaged items** — Claude's interpretation, with root-cause hypotheses where applicable.
  3. **Decisions** — table of item → resolution → plan-id mapping.
- Pre-existing failures discovered mid-execution go into `.planning/phases/{phase}/deferred-items.md` (one section per discovery date). These survive across rounds — don't try to fix them inside an unrelated plan.
- Each Decision-of-Record (in the per-phase `07-CONTEXT.md`) gets a `D-NN` ID with the date. When a later decision supersedes or partially-reverses an earlier one, the later D-NN explicitly references the earlier (e.g., D-58 supersedes D-57). Don't delete the old D-NN entry; the chain is the history.

## Test discipline

- TDD: RED commit → GREEN commit. Each phase's commit log should read RED→GREEN→RED→GREEN in roughly equal counts. Plans without a RED commit are doing exploration, not execution — that's fine but flag it (`type: "auto"` with `tdd="false"` and a documented reason).
- Pre-commit hooks (`gen-check` + `golangci-lint` + `eslint`) MUST pass on every commit. No `--no-verify` unless explicitly authorized for the specific commit.
- Pre-existing test failures are tracked in `deferred-items.md`. New failures are blockers.

## Flaky tests are bugs (2026-06-05)

**A test that fails non-deterministically is a defect — either in the test or in the code under test — and must be fixed, not retried, quarantined, or skipped.**

- **Never label a flake as "transient" and move on.** The convenient explanations ("filesystem race", "CI timing", "intermittent") almost always conceal a real race condition in production code or a real test-infra bug (TOCTOU, shared global state, leaked goroutines, missing wait-for-ready synchronization). The Phase 9 surrounding work surfaced this directly: TestApp_Run_FreshDB was labelled "filesystem race / pre-existing" by an executor; the actual cause was a TCP-port TOCTOU between `pickFreePort` closing the listener and the SUT re-binding it — fixed in commit `491169d`. The "race" diagnosis was correct in spirit but the fix would never have happened without isolating it.
- **Reproduce before you theorise.** `go test -count=N ./internal/app/` (isolated) AND `go test -count=N ./...` (full sweep). A test that passes 30/30 isolated but flakes in `./...` mode is suffering from cross-package state interference, not "luck."
- **HTTP readiness probes, not TCP.** Any test that boots a server and then asserts on application state MUST use a probe that confirms the application is ready (HTTP round-trip to a known endpoint), not just that the kernel accepts TCP. Pre-bound listeners (`net.Listen` → close → re-bind by SUT) accept TCP the moment they're bound but the handler chain isn't wired until much later in startup. See `httpReadyProbe` / `diskFullReadyProbe` in `backend/internal/app/app_test.go` for the canonical pattern.
- **`t.Cleanup` over `defer` for resources that outlive the test goroutine.** Listeners handed to `http.Server.Serve` are closed by `Server.Shutdown`; the `t.Cleanup` registration is a safety net for crash paths, not the primary close.
- **Order discovery, then fix.** If a flake reproduces only in the full-suite sweep, name the offender by running with `-shuffle=on -p 1` and capturing `-v` output. Don't guess at "which test is leaving state behind."
- **Allowed shortcuts: none.** `t.Skip` under a build tag, retries via `testing.Run` loops, `time.Sleep` "to let it settle" — all of these encode the flake into the test rather than fix it.

**Known instances awaiting fix** (treat as blockers, not deferred items):

- `backend/internal/app/lifecycle.go:297-299` — `registry.Hydrate` silently no-ops when `indexer.List(ctx)` returns an error; under parallel-package filesystem load this surfaces as `TestApp_Run_FreshDB_BootsAndIndexesScratchpad` returning `notes:[]` instead of the seeded scratchpad. Either retry, fail-fast, or surface the error to the caller — but warn-and-proceed-with-empty-registry is wrong both for tests and for users.
- `TestApp_Run_DiskFull_ServesStaticPage` / `TestRun_DiskFull_PreflightHaltsBeforeOpen` — intermittent 5s `waitFor` timeout in `./...` sweep mode despite the dedicated `diskFullReadyProbe`. Root cause not yet isolated; likely deeper interaction between `JASPER_TEST_FORCE_DISK_FULL` env timing and parallel sqlite/filesystem activity.

When fixing one of the above, delete its bullet from this list AND add a one-line entry under it referencing the commit that fixed it, so the history of "we knew about this and fixed it" stays in this file.

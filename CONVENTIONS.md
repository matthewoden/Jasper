# Conventions

Project-level process rules — **how** we build, test, and verify.

The other two documents: [`CONTEXT.md`](./CONTEXT.md) is the vocabulary and the invariants; [`docs/adr/`](./docs/adr/) holds decisions and their rationale. This file is the only one about process.

Nearly every rule below was earned from a specific incident. The incidents are kept because a rule without its scar is the first thing someone talks themselves out of.

## Build & embed pipeline

- **Always use `make build` for any binary that will be tested or shipped.** The `build` target copies `frontend/dist/` into `backend/internal/static/dist/` between `npm run build` and `go build`. Skipping that copy bakes the *previous* frontend bundle into the binary via `//go:embed all:dist`, producing a stale UI that looks like a code bug.
- For any instruction that says `npm run build && go build`, treat it as a defect and replace it with `make build`.

*Incident: a full UAT walkthrough was lost to this — the binary contained old UI code despite the source being correct. The instinct to type the two commands separately persisted for weeks afterward.*

## Verification: E2E before human UAT

- **Any fix for a user-facing bug needs a Playwright scenario against the built binary**, not just a vitest unit test. Land it *before* asking for human verification.
- The user's time is the most expensive thing in the loop. Don't spend it on a stale binary or an already-broken feature.
- E2E specs live in `frontend/e2e/`.

*Incident: 593 unit tests stayed green while the live browser had wrong computed widths, broken tree keymaps, incorrect focus, and reentrancy bugs. jsdom simulates the DOM but not layout, focus, or event timing — and it cannot verify CodeMirror rendering at all.*

## Verify on the real surface

The single most repeated lesson in this project, found the hard way in four consecutive milestones:

- **The bug is found by the built binary, a real mouse, a real click, or measured glyph rects** — not by the test runner.
- **Drive UAT the way the app is actually used.** Keyboard-only E2E structurally cannot reach a click-only code path; one such bug survived a passing keyboard test and was reproduced instantly by clicking.
- **Test the right target, not just "a test exists."** A visual assertion once measured the editor root instead of rendered text and passed while every line of prose rendered in the wrong font. Another measured an element's bounding box instead of glyph rects and couldn't see a 6px text inset. **A green check on the wrong node hides a defect the user sees immediately.**
- **Authored is not validated.** An install harness existed for an entire milestone before anyone ran it; its first real execution surfaced roughly seven latent defects. A harness that has never gone green is untested code.

## Investigation-first for behavioral reports

- For any report phrased as "X doesn't work / shows wrong / behaves weird", **reproduce and root-cause before writing the fix.** Backend behavior is cheap to verify with one HTTP probe; frontend behavior shows in the dev server's logs and console.
- The investigation can be inline (5–10 minutes, captured in the issue) or a dedicated investigation note for anything larger.
- **Calibration: ~15 minutes reproducing saves roughly a full round of speculative work.** One skipped investigation shipped a "make it debuggable" patch instead of finding the cause — which turned out to be a deliberate backend refusal the reporter had assumed was a frontend bug.

## Stop when an investigation is inconclusive

- When work pairs *investigate → fix*, the fix step must **re-read the investigation's conclusion first**. If it doesn't name a specific file, line, and concrete change, **stop and surface it** rather than speculatively patching.
- This gate has caught several would-be patch cycles, including a contract drift that a speculative fix would have papered over.

## Ask before drafting, when the ask is ambiguous

- For any item phrased without a direction — "alignment is off", "the indicator is in the wrong place", "search doesn't feel right" — **ask before writing the fix**, not after it lands.
- Cluster 2–4 ambiguities into one question; a single multi-question prompt is cheaper than serial back-and-forth.
- Record the answers in the issue so the decision trail survives.

*Incident: two UAT items each cost an extra round because an interpretation was made instead of a question asked.*

## Soft-accept vs hard-accept

- An "accepted" during a same-day walkthrough is a **soft-accept**: they tried it once and didn't immediately reject it.
- A **hard-accept** requires surviving 24–48h of real use without being flagged again.
- Work depending on a prior acceptance should note that it's a soft-accept, with the date, so the dependency is auditable.
- **Don't delete code reversed under a soft-accept** — orphan it until the next round confirms the reversal sticks.

*Incident: an item soft-accepted in one round was reversed two rounds later.*

## For UI work, code-verified is not accepted

- **Budget a subjective-feel round explicitly.** One UI-heavy phase passed all 22 of its criteria on day one and still needed five hands-on rounds; a verified decision was reverted in use.
- No automated gate shortens this tail. Tooltip placement, caret behavior, and visual cohesion settle by eye or not at all.

## Keep the plan and the investigation in sync

When an investigation concludes something different from the plan's example code, **either amend the plan or write the plan investigation-first** (no straw-man example; link the investigation as the single source of truth).

*Incident: a plan's example showed one API shape while the investigation correctly chose another. The plan stayed stale and three separate executors had to be re-briefed about the deviation.*

## Orphaned code is a design signal

- Before adding a component, **grep for one that already does the thing.** If it exists with no consumers, ask *why was this orphaned* before re-deriving the original design the long way around.
- Useful: `git log --diff-filter=D -- '<file>'` (deleted and re-added?), `grep -r 'import.*ComponentName' --include='*.tsx'` (any consumers?), `grep -l 'data-testid="some-id"' src/` (tests referencing unreachable surfaces?).

*Incident: two search components sat orphaned across four plans before being remounted. Noticing earlier would have skipped an entire merge arc — the original architecture already matched the user's mental model.*

## Work sizing: bundle vs split

- **Bundle** small, well-scoped fixes where each task is under ~30 minutes and the failure surface is localized.
- **Split** anything with investigation, design ambiguity, or a cross-cutting refactor.
- Rule of thumb: if any task in a bundle would benefit from its own investigation note, split it out.
- Bundles save overhead but complicate resumption when something fails mid-flight.

## Worktree vs in-main

- **Default to in-main** for sequential single-threaded work. Cherry-pick overhead exceeds the parallelism gain at ≤2 concurrent efforts, and recurring "recover lost worktree merge" commits document the failure mode.
- **Use a worktree** only when ≥3 efforts run in parallel across disjoint code, or the work might destabilize main temporarily, or you want two approaches side by side.
- After worktree work, verify caches are clean (`go clean -cache && golangci-lint cache clean`) to avoid stale-path lint errors from the abandoned source tree.

## Test discipline

- **TDD: RED commit → GREEN commit.** A change log should read RED→GREEN→RED→GREEN in roughly equal counts. Work without a RED commit is exploration rather than execution — fine, but flag it.
- **A regression test must be proven to fail before the fix.** If it passes on the pre-fix tree, it isn't testing the right thing.
- Pre-commit hooks (`gen-check`, `golangci-lint`, `eslint`) must pass on every commit. No `--no-verify` unless explicitly authorized for that specific commit.
- Pre-existing failures are tracked; **new failures are blockers**.
- **Treat setup-phase errors as hard failures.** A flag rename once silently broke ~58 tests at setup while the suite still reported them as passing. A pass count is meaningless if errors before the assertions don't count.

## Flaky tests are bugs

**A test that fails non-deterministically is a defect — in the test or in the code under test — and must be fixed, not retried, quarantined, or skipped.**

- **Never label a flake "transient" and move on.** The convenient explanations — filesystem race, CI timing, intermittent — almost always conceal a real race, a TOCTOU, shared global state, a leaked goroutine, or a missing readiness wait. One test dismissed as a "filesystem race" turned out to be a genuine TCP-port TOCTOU between the test picking a free port and the server re-binding it.
- **Reproduce before theorizing.** Run isolated (`go test -count=N ./internal/app/`) *and* in the full sweep (`go test -count=N ./...`). Passing 30/30 isolated but flaking in `./...` means cross-package interference, not luck.
- **HTTP readiness probes, not TCP.** A test that boots a server and asserts on application state must probe with a real HTTP round-trip. A pre-bound listener accepts TCP the moment it's bound, long before the handler chain is wired.
- **`t.Cleanup` over `defer`** for resources outliving the test goroutine.
- **Order discovery, then fix.** If a flake only reproduces in the full sweep, name the offender with `-shuffle=on -p 1` and `-v`. Don't guess which test leaves state behind.
- **Allowed shortcuts: none.** Not `t.Skip` behind a build tag, not retry loops, not `time.Sleep` "to let it settle." Each encodes the flake instead of fixing it.
- **Poll for the eventual condition** rather than sleeping a fixed interval.

**Known instances awaiting fix** (blockers, not deferred items — all three verified still present):

- `backend/internal/app/lifecycle.go:~290` — registry hydrate silently warns and proceeds with an empty registry when the index list fails. Under parallel filesystem load this surfaces as a boot test finding no notes. Retry, fail fast, or surface the error — warn-and-proceed-empty is wrong for tests *and* for users.
- `TestApp_Run_DiskFull_ServesStaticPage` / `TestRun_DiskFull_PreflightHaltsBeforeOpen` — intermittent timeout in `./...` sweep mode despite a dedicated readiness probe. Root cause not isolated; likely an interaction between the forced-disk-full env timing and parallel sqlite/filesystem activity.
- **`panic("boom")` escapes under full-suite `go test ./...`.** The panic originates in `backend/internal/app/middleware_test.go:150` (`TestSecurityHeadersMiddleware_HeadersPresentOn500`, which deliberately panics through `middleware.Recoverer`), but Go reports it against whichever test ran concurrently — usually `TestApp_Run_FreshDB_BootsAndIndexesScratchpad`, which is **not** the culprit.

  This is a textbook case of the reproduction rule above. It passes every isolated form — the app package alone 8/8, `-race -count=5`, the named test at `-count=20` — and fails *only* under cross-package parallelism. A debt gate that ran the app package in isolation never caught it.

  Repro: `cd backend && for i in $(seq 1 10); do go test ./... -count=1 >/dev/null 2>&1 || echo "run $i FAIL"; done`

  For the fixer: does `middleware.Recoverer` re-panic, or is there an unrecovered goroutine in the app-boot path the panic rides on? Diagnose the real race — don't skip or retry.

When one is fixed, delete its bullet and add a one-line entry referencing the fixing commit, so "we knew and fixed it" stays in the history.

## Testing patterns

Commands:

```bash
cd backend  && go test -race ./...        # always with the race detector
cd frontend && npm test -- --run          # vitest, single run (CI mode)
cd frontend && npx playwright test        # E2E against the built binary
```

**Backend**

- Tests are colocated (`foo.go` ↔ `foo_test.go`, same package). Table-driven throughout.
- `t.Helper()` in helpers so failures point at the caller; `t.TempDir()` for isolation; `t.Cleanup()` for resources that outlive the test goroutine.
- **In-test fakes over mocking frameworks.** Lightweight structs implementing the real interface, capturing call counts and last-call arguments. Zero-valued fields default to no-ops so setup stays minimal.
- **A shared `observedSeq` slice pointer across fakes asserts *ordering*** — this is how the file-first-then-index contract is actually enforced in tests rather than assumed. See [ADR-0007](./docs/adr/0007-file-first-save-path.md).
- **Mock the dependencies, never the thing under test.** Always instantiate the real struct being tested.
- Sentinel errors are checked with `errors.Is()` — never `==`, never string matching.
- Concurrency correctness gets stress coverage, not just unit coverage (a 5,000-note concurrent-write stress runs clean with zero `SQLITE_BUSY`).

**Frontend**

- vitest + jsdom, colocated (`Foo.tsx` ↔ `Foo.test.tsx`), `@testing-library/react`.
- `vi.mock()` at module level for external APIs and environment-dependent hooks. **Don't mock the component under test or the components it directly composes** — those should be integrated.
- `waitFor()` for async state; it retries until pass or timeout.
- Remember what jsdom cannot do: layout measurement, real focus, true event dispatch, and **any CodeMirror rendering**. Green component tests are not coverage for those.

**E2E**

- Specs live in `frontend/e2e/`. `spawnJasper()` gives each test a fresh data directory and an **ephemeral port** — never the default 6683.
- **Fully parallel** (`fullyParallel: true`, 4 workers locally / 2 in CI). **`retries: 0` on purpose** — an E2E flake is a real bug, and a retry hides it.
- Generous `expect` timeout (10s) because a real binary boot plus UI render is genuinely slow.
- Tag scenarios (`@first-run`, `@reveal`, …) for selective runs via `--grep`.
- **Run `make build` first.** The suite drives the embedded binary; `npm run build` alone leaves it stale.
- **Never assert a rejection from page context.** A browser owns `Origin` and `Host` and treats both as forbidden headers — page JavaScript cannot set them. A `page.evaluate(fetch(...))` aiming to prove a cross-origin or rebound request is refused will have those headers silently replaced with legitimate loopback values, the request will pass, and the test will look like it proved something while proving nothing. This is the trap that made earlier CSRF work hard to verify.

  Route the assertion by layer instead:
  - **Rejection (attack-path) → Go `httptest`.** `Host` and `Origin` are freely settable at the handler level. Cheap, deterministic, cross-platform. For a WebSocket upgrade, go one lower still — a raw TCP handshake, since a WS client library derives `Host` from the dial URL.
  - **Playwright `request` (APIRequestContext) can set `Origin`** — it bypasses the browser — so it can cover an Origin-reject path. **`Host` override is unreliable through it**, so Host cases stay in Go.
  - **Playwright page context → happy path only.** Its job is proving the app still works after a guard lands: legit-origin mutations succeed, the WS connects, the SPA loads.

**Performance gate:** `make perf-vault` generates a deterministic 5,000-note vault; `make perf-check` asserts cold start (migrations + incremental re-index) stays under 5s.

## No GET endpoint mutates the filesystem

**Safe methods stay safe.** `GET`, `HEAD` and `OPTIONS` must not create, modify, move, or delete anything on disk. Creation belongs on `POST`.

*`GET /daily-notes/{date}` was a get-or-create. That made a plain `<img src="http://127.0.0.1:6683/api/v1/daily-notes/2099-12-31">` on any page the user visited write a file into the vault: the CSRF Origin guard deliberately skips safe methods, and the Host allowlist cannot help because such a request carries a genuinely loopback Host. The attacker never reads the response — the side effect is the payload.*

The convenience shape is worth keeping; it belongs in the client, as GET-then-POST-on-404, not in the verb.

## Comment policy

Applies to **code comments** (`//`, `#`, `/* */`, JSDoc). Process and planning documents may cite freely — this rule is about source.

- **Comment *why*, never *what*.** The code already says what it does. A comment restating it (`// loop over notes`) is noise that drifts out of sync. Delete on sight.
- **Only non-obvious decisions earn a comment** — a surprising constraint, an upstream-bug workaround, a deliberate deviation, an ordering that matters subtly. If a competent reader wouldn't ask "why is this like this?", no comment.
- **No planning-artifact references in code.** Strip phase numbers, plan IDs, decision IDs, review IDs, and "see SUMMARY.md" from comments. They rot the moment the artifact is archived and mean nothing to someone reading the code cold. **Keep the reason if it's still load-bearing; drop the citation.** Done right: `# --vault requires an absolute path, hence $PWD` states the live constraint and names no plan.
- **Thin everywhere.** Prefer a clear name or a small refactor over a comment. When one is warranted, one line beats a paragraph.
- **A stale comment is a bug** — worse than none. Fix or delete it the moment you notice, same as a flaky test.
- **Functional/directive comments are exempt.** Anything the toolchain reads — `//go:generate`, `//go:embed`, build tags, `// nolint`, `// eslint-disable*`, `// @ts-expect-error`, codegen banners — is code, not prose. Leave it.

## Issue capture

Issues and specs live as markdown under `.scratch/` — see [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md) for the layout and [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md) for the status vocabulary.

- Capture raw feedback **verbatim** before interpreting it. The interpretation goes in a separate section, so a wrong reading can be caught against the original words.
- Record decisions as an explicit item → resolution mapping.
- **When a later decision supersedes an earlier one, reference the earlier one explicitly rather than deleting it.** The chain is the history — and the same rule governs ADRs (see [`docs/adr/README.md`](./docs/adr/README.md) on precedence).
- Pre-existing failures discovered mid-work get recorded separately rather than fixed inside unrelated work.

## Ticket identity

**A ticket's identity is its path.** `audit-findings/02` — effort directory plus file number — names exactly one file. Write it that way in prose, in cross-references, and when handing work to someone else.

- **Don't mint categorical prefixes** (`OPS-`, `BE-`, `DUR-`). A category says what a ticket is *about* but not where it lives, so every reference costs a search — and the category is the part a one-line summary would have given you anyway. The path is unambiguous, greppable, and already the file-naming standard in [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md).
- **Requirement IDs scoped to one spec are different, and fine.** `PROPS-08` is numbering *within* the document that defines `PROPS`, and that document is its own legend. Keep them inside their spec; the moment one appears in a commit message or another effort's ticket, it has escaped.
- **Name a finding by what it is.** Inside a ticket that groups several, the heading is the name — "Teardown order is wrong; a failed swap bricks the server", not "BE-02". A reader who has never opened the file still knows what you mean.
- **Commit scopes name the area, not the ticket** — `fix(app-lifecycle)`, not `fix(ops-02)`. The scope survives; the ticket does not. Cite the ticket in the body if it adds anything the body doesn't already say.
- **When a scheme does get retired, leave a provenance note** in the effort that used it, so the labels still in git history and old commit messages stay decodable. The note is history, not an index — nothing live should need it.

*The `review/` audit minted seven category prefixes — `BE`, `DUR`, `OPS`, `PERF`, `SY`, `DI`, `FE` — across roughly fifty findings, then was deleted once those findings were transferred. The legend went with it, leaving ~180 references to identifiers nothing in the repo expanded, ~30 of which had leaked into test names, script comments, a CI workflow and two filenames. Reading `OPS-02` cost one grep to learn it was about logging and a second to learn which file held it — the same rot the [comment policy](#comment-policy) already bans from source, arriving through prose instead. They were retired when this rule landed.*

## Requirements traceability

**Mark a requirement complete in the same change that ships it** — not at milestone close.

*Two consecutive milestones closed with traceability tables contradicting what had actually shipped. Reconciling at close works but re-discovers the same drift every time; marking in-band is the durable fix and has held since.*

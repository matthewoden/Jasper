# Handoff — implement Universal Item References (phases 1–3) in one pass

Written 2026-10-04. Repo: `/Users/matthewpotter/Projects/jasper`. Branch: `docs/universal-item-references` (one commit ahead of `main`, unpushed, `c896922`).

## What you are doing

Implement **phases 1, 2 and 3** of the plan at **`docs/plans/universal-item-references.md`**, end to end, on this branch (or a fresh `feat/item-refs` branched from it). Phase 4 (gateway hookup) is deferred; don't build it.

The plan is the source of truth. It contains the story breakdown (§6–§8), the ADR amendments owed (§3), the decisions already taken (§1), answers to the spec's open questions (§4), new open questions with defaults (§5), the acceptance-criteria → story map (§10) and the risks (§11). **Don't re-derive any of that here; read the plan first.** The original spec it amends was supplied as an upload and is not in the repo; the plan supersedes it.

## Decisions the owner has already made — do not reopen

Recorded in plan §1. In short: **ULID ids** (not UUID, not carry-forward), **no `body` ACL** on GraphQL, **id-based blob embeds** `![[jasper:blob/sha256-…|name]]` for new uploads, planning lives in the repo doc (no tracker tickets were filed).

For the plan's *new* open questions (§5, N1–N12): **take each recommended default without asking.** N1 (who owns the `Item` interface) was resolved on 2026-10-05 by a composition spike in the graphos repo (its ADR-0001): `Item` is a value interface with no `@key`, `@key` goes on the concrete types, `ForeignRef` and `Action` are `@shareable`, and Jasper's root fields are `jasperItem`, `jasperItems`, `jasperBacklinks`, `jasperSearch`. No spike in story 3.4; record the choice in the ADR-0006 amendment and point at the graphos ADR.

## Facts the investigation established (don't re-investigate)

All in plan §2 with `file:line` citations as of `d9017e9`. The ones that most shape the work:

- Note ids are indexer-minted UUID v4s living only in SQLite; `uuid.UUID` is the type at ~40 backend sites; `format: uuid` at ~25 note-id sites in `api/openapi.yaml`. Frontend treats ids as opaque strings.
- Both frontmatter writers (`markdown/tags.go`, `notes/rewriter.go`) re-serialize via `yaml.v3` — **no byte-preservation tests exist**. Insert the `id:` line textually; never re-serialize.
- `index/store.go` `Upsert` uses `ON CONFLICT(id) DO UPDATE SET path` — duplicate ids must be detected *before* upsert.
- Attachments are not indexed at all; `WalkVault` skips `attachments/`.
- `SyncBacklinks` is one `BEGIN IMMEDIATE` transaction per source — the `refs` writes join it.
- MCP: reads global, writes grant-gated (tier 1/2). No read tier.
- WS events use colon names → the new event is `refs:changed`.
- Editor wiki-links are a regex `MatchDecorator` in `frontend/src/editor/wikilinkPlugin.ts`, not lezer; `@` is unbound; `fileChipWidget.ts` is the chip to copy; completion sources are an `override` array in `MarkdownEditor.tsx` (~line 439).
- **gqlgen must be pinned at v0.17.94** (v0.17.95 needs Go 1.26). It uses `coder/websocket` (bump ours 1.8.14 → 1.8.15), no CGo, federation v2 incl. entity interfaces; codegen as a `go.mod` `tool` directive.
- The existing one-time file-rewriting migration to model on: `backend/internal/app/frontmatter_migration.go` (+ its tests). Doctor checks: `backend/cmd/jasper/doctor.go:86-99` slice pattern.

## Execution order

Follow the story numbering. Non-negotiable sequencing:

1. **1.1 alone, as a pure retype commit** (UUID → `notes.ID` ULID, OpenAPI pattern, `make gen`, scratchpad constant on both sides, bookmarks validator). Zero behaviour change; all existing tests green before moving on.
2. **1.2 before 1.3/1.4/1.7** — the `WithID`/`ReadID` primitives with golden byte tests are the foundation everything writes through.
3. Phase 1 fully green (incl. `make perf-check` with attachments in the perf vault) before phase 2.
4. In phase 2, **2.1/2.2/2.3 (backend refs) before 2.5/2.6/2.7 (editor)**; 2.4 REST endpoints are what the editor consumes.
5. Phase 3: **3.1 scaffold → 3.4 spike (N1) → 3.2/3.3 resolvers → 3.4 composition test → 3.5 MCP**. Run the spike before writing resolvers so the SDL shape is settled.
6. ADR amendments and `CONTEXT.md` glossary changes (§3, stories 1.8 / 2.7 / 3.6) land **in the same commit as the behaviour they describe**, not at the end. Amend existing ADRs; do not mint new numbers (see `docs/adr/README.md` precedence rule).

Commit per story with conventional scopes (`feat(notes-id): …`, `feat(refs): …`, `feat(graphql): …`) — area scopes, never phase/ticket scopes. Commit messages end with the attribution line the harness supplies.

## Environment gotchas (from project memory — these have all bitten before)

- `go build/test/vet`, `golangci-lint`, `git commit` (lefthook) and Playwright **fail under the Bash sandbox** with "operation not permitted" / "listen EPERM". Run them with `dangerouslyDisableSandbox: true`; it's the sandbox, not a regression.
- E2E runs against the **embedded Go binary**: run `make build` (not `npm run build`) before Playwright or the served page is stale.
- **Never `npm install`** to update `frontend/package-lock.json` — `make lock`. Never `npm install` inside a worktree.
- Boot tests in `internal/app` must `t.Setenv("JASPER_APP_HOME", …)` or they read the real `~/.jasper/app.json`.
- Zero tolerance for flaky tests — poll for the eventual condition, prove with repeated runs. Daily-note E2E has a known UTC-midnight flake unrelated to this work.
- Comments: as few as possible, why-only; no planning-doc references in code.
- A gitignored `frontend/vite.config.js` can shadow `vite.config.ts` in `make dev`.
- Frontend UAT needs real-browser screenshots; DnD isn't touched here, but the `@` picker and chips are UI — present screens at the end.

## Verification gates before declaring done

- `make lint`, `make gen-check` (now also covering the GraphQL SDL + generated code), `go test ./...`, `npm test -- --run`.
- `make build` then **full** Playwright suite (not a targeted run) — this is the phase-close gate.
- `make perf-check` with the perf vault extended for attachments (1.6) and for 10k×20 refs (2.9); backlink benchmark < 10 ms.
- Every acceptance criterion in plan §10 except #10 (dropped) and #14 (phase 4) has an automated test.
- `jasper migrate-ids --dry-run` on a copy of a real vault writes nothing; the real run changes only `id:` lines (`git diff` on the vault copy proves it).
- `CGO_ENABLED=0 go build` succeeds; note the binary size delta in the ADR-0006 amendment.

## Suggested skills

- **`mattpocock-skills:tdd`** — the acceptance criteria are already a test list; drive each story red → green.
- **`mattpocock-skills:domain-modeling`** — for the ADR amendments and `CONTEXT.md` glossary entries (Ref, Blob, Tombstone, Note/Registry rewording).
- **`mattpocock-skills:code-review`** — run against `main` after each phase; standards + spec axes, with the plan as the spec.
- **`mattpocock-skills:diagnosing-bugs`** — if the perf gate or a Playwright run regresses.
- **`run`** — to drive the built binary and capture the `@` picker / chip / hover-card screenshots for UAT.
- `simplify` — after phase 1's retype, to catch leftover UUID-shaped code.

## Pre-existing bugs noticed, out of scope — file, don't fix here

- CRLF frontmatter gets a second LF block prepended on save (`service.go:139` prepends on `!HasFrontmatter`).
- `RewriteWikilinksAST` appears to drop `#fragment` when rewriting a renamed link (`rewriter.go:178-183`), untested.
- Frontend wikilink resolver doesn't split `#fragment`, so `[[Foo#Bar]]` shows pending though the backend resolves it.
- Three ad hoc frontmatter fence scanners (`\n---` match) diverge from the strict `HasFrontmatter` contract — story 1.2 must *not* add a fourth; consolidating the three is a follow-up.

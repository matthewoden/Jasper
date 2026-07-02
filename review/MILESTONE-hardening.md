# Milestone Context — v1.3 "Hardening"

> **Purpose of this file.** This is a ready-to-ingest `MILESTONE-CONTEXT.md` for `/gsd:new-milestone`. It turns the `review/` audit into a scoped, phased milestone with REQ-IDs traceable to finding IDs. **Launch it only after v1.2 Visual Redesign wraps** (`/gsd:complete-milestone` for v1.2 first).
>
> **How to launch when ready:**
> 1. `cp review/MILESTONE-hardening.md .planning/MILESTONE-CONTEXT.md`
> 2. `/gsd:new-milestone` — it reads MILESTONE-CONTEXT.md, confirms the version (suggest **v1.3**), defines REQ-IDs, and spawns the roadmapper to phase it. It deletes MILESTONE-CONTEXT.md once consumed (the copy in `review/` stays as the source of record).
> - Prefer to resolve the open decisions first? Run `/gsd:discuss-milestone` — it writes MILESTONE-CONTEXT.md for you; fold the "Owner decisions" section below into that discussion.
>
> **Version note.** v1.0 and v1.1 already shipped; v1.2 is in progress. This is **v1.3**, not the "v1.1 Hardening" the older `GSD-INTAKE.md` proposed (that name predates the v1.1/v1.2 numbering). `/gsd:new-milestone` will confirm the number.

---

## Goal

Close the architectural, correctness, security, and durability gaps surfaced by the `review/` audit — hardening the save/sync/boot paths and the security posture so "writing, searching, and organizing notes feels native and trustworthy" holds under multi-tab, multi-tool, and hostile-network conditions.

## Target features (scope themes)

- **Security posture** — eliminate the DNS-rebinding drive-by exfiltration path and the state-changing-GET / symlink / inline-SVG gaps.
- **Conflict & external-edit safety** — make optimistic locking actually cover the autosave/keepalive/reconnect paths, detect external changes, and never silently clobber.
- **Write-surface parity** — MCP and REST produce identical vault state; the WS event contract is typed end-to-end.
- **Lifecycle robustness** — one boot/swap path, a safe migration-rollback ladder, real logging, no boot-time data races.
- **Frontend shared data layer** — one tree/note store instead of N per-tab copies and five pub/sub buses; collapses the interlocked FE + perf findings.
- **Backend hygiene & performance headroom** — de-duplicate the bulk-rewrite/registry/port-downcast debt; reclaim reconcile and tree-refresh headroom.
- **Durability tooling** — external-change detection, soft-delete restore, backup/version tooling.

---

## Already shipped ahead of this milestone (EXCLUDE from scope)

Delivered this session on `main` as `/gsd:quick` tasks — do **not** re-plan:

| Finding | What shipped | Commit |
|---------|--------------|--------|
| **OPS-01** | GitHub Actions CI: `go test -race`, golangci-lint, vitest, eslint, `tsc`, `make gen-check` | `66297e5` |
| **DI-01** | Interactive saves populate `BodyFTS`/`TagNamesFTS`; body-searchable without reconcile | `74634e0` |
| **DI-02** | Registry `Hydrate` populates `byTitle` from index; backlinks resolve after restart | `5a9ca52` |
| **SY-01** | Daily-note create routed through `notes.Service`; `file:*` WS events; 22/22 two-session E2E | `726b53b`, `1bcb106` |
| **SY-05** | MCP `update_note` requires `if_match` (handler-enforced), honest `force_write` | `01bd12a` |
| *(fallout)* | markdown package-comment lint fix; frontmatter boot-test de-flake | `f6d1b07`, `2517ce1` |

**Consequences for remaining findings:** DI-01/DI-02 fixes mean daily notes now inherit correct FTS + title-index (SY-01 built on them). **H1/H2 of the old `GSD-INTAKE.md` are fully closed.** DUR-02 and PERF-01/02 fold into other phases below (noted inline).

---

## Proposed phases (roadmapper will finalize)

Ordered by risk-then-dependency. Tier = dominant executor; **opus** phases need `/gsd:discuss-phase` → `/gsd:plan-phase` → `/gsd:execute-phase`, **sonnet** items are `/gsd:quick`-shaped. Every finding's authoritative acceptance ("Done when") lives in the cited `review/` file — REQ-IDs reuse the finding IDs so coverage stays traceable.

| Phase | Theme | Closes (REQ-IDs) | Tier | Source |
|-------|-------|------------------|------|--------|
| **H-SEC** | Security remediation | SEC-01, SEC-02, SEC-03, SEC-06, SEC-04, SEC-05, SEC-07, SEC-08 | opus (01/02/03/06) + sonnet | `06-security.md` |
| **H-CONFLICT** | Conflict & external-edit safety | FE-07 → DI-03 → DUR-02 → SY-02 → DI-04; DUR-01, DUR-05, DUR-04 | opus · L (flagship) | `01`, `02`, `07`, `04` |
| **H-PARITY** | Write-surface & event contract | SY-03, SY-04, BE-09, BE-11 | opus (SY-03) + sonnet | `02`, `03` |
| **H-LIFECYCLE** | Boot / swap / migration hardening | BE-01, BE-02, DI-05, OPS-02, BE-05, BE-06, BE-08, OPS-04 | opus + sonnet | `03`, `01`, `05` |
| **H-FRONTEND** | Shared data layer + FE perf | FE-01, FE-02, FE-04, FE-05, FE-06, FE-03, PERF-01, PERF-02 | opus · L | `04`, `08` |
| **H-BACKEND** | Backend hygiene + remaining perf | BE-03, BE-04, BE-07, DUR-06, BE-10, PERF-03, PERF-04 | opus/sonnet | `03`, `07`, `08` |
| **H-DURABILITY** | Durability & ops tooling | DUR-03, DUR-07, DUR-08, OPS-03, OPS-05, OPS-06 | sonnet + opus (policy) | `07`, `05` |

**Sequencing rationale**
- **H-SEC first** — SEC-01/02 are a drive-by, unauthenticated exfiltration of all note content via DNS rebinding; nothing else outranks that. SEC-02 rides SEC-01's Host fix; SEC-06 extends it to the MCP listener.
- **H-CONFLICT is the flagship arc** — FE-07 (extract `useNoteSave`) is the enabler; DI-03 threads If-Match through every save path; DUR-02 is the external-edit facet of the same root; SY-02 makes reconnect a revalidation barrier; DI-04 fixes the two-clocks / TOCTOU. DUR-01/04/05 supply the external-change detection this depends on. Watch the frontmatter-rewriteback timing trap called out in DI-03 (the reason it's opus).
- **H-FRONTEND collapses interlocked findings** — one shared tree/note store fixes FE-02, FE-04, and the perf depth PERF-01/PERF-02 at once; do the store first, the rest fall out.
- **H-BACKEND pairs debt with perf** — BE-07 (bulk-rewrite triplication) and DUR-06 (crash mid-rewrite) are the same code; PERF-03 pairs with the DUR-01 watcher (derive folders from DB, invalidate on FS events).

### Per-phase requirement notes

**H-SEC** — `06-security.md`
- SEC-01 (HIGH/opus): validate `Host` against an allowlist; reject drive-by cross-origin. Must account for `--bind` LAN mode (Phase 13) — configurable allowed hosts.
- SEC-02 (HIGH/opus, rides SEC-01): WS handshake must enforce Host, not rely on coder/websocket's same-Host shortcut.
- SEC-03 (MED/opus): `GET /daily-notes/{date}` must not create files (state-changing GET) — resolved naturally if it routes through the SY-01 service create with a non-GET verb or origin guard.
- SEC-06 (LOW-MED/opus): Host/Origin validation on the MCP listener (6684).
- SEC-04 (MED/sonnet): serve user SVG with `Content-Disposition: attachment` / non-inline type. SEC-05 (MED/sonnet): symlink-resolve parity in REST file/attachment + MCP `read_attachment`. SEC-07 (LOW/sonnet, overlaps OPS-05): non-world-readable data dir/DB perms. SEC-08 (LOW/sonnet): escape `excerpt_html` server-side.

**H-CONFLICT** — `01`, `02`, `07`, `04`
- FE-07 (enabler, opus): extract `useNoteSave`; collapse duplicated keepalive raw-fetch.
- DI-03 (HIGH/opus): thread `lastKnownUpdatedAt` through every `performSave`, keepalive, and reconnect; 409 → conflict banner. Two-session E2E acceptance in `01-data-integrity.md`.
- DUR-02 (HIGH/opus): open editor must not overwrite external edits — same root as DI-03.
- SY-02 (HIGH): reconnect = full revalidation barrier (refetch `/vault/current`, tree, per-pane note, fire tag/link/grant events); JSON 503 during swap.
- DI-04 (MED/opus): one canonical version (explicit `etag` vs nanosecond mtime — **owner decision**); keyed write mutex for the Stat→Write TOCTOU.
- DUR-01 (HIGH/opus): external-change detection (fsnotify vs poll — **owner decision**). DUR-05 (MED): mtime+size/checksum. DUR-04 (MED/opus, WSL): case/NFC-NFD drift hides external notes — test on a case-sensitive FS.

**H-PARITY** — `02`, `03`
- SY-03 (HIGH/opus): move rename-rewrite orchestration into `notes.Service.Move` so MCP `move_note` rewrites wiki-links like REST; kills fabricated `UpdatedAt` (DI-04 overlap).
- SY-04 (MED/sonnet): model WS envelope as a discriminated union in the spec; typed payloads; add the 6 missing schemas; unify `target_path`/`path`; remove/implement `migration:status`.
- BE-09 (LOW), BE-11 (LOW/sonnet): converge MCP error mapping with API; type `Error.code`.

**H-LIFECYCLE** — `03`, `01`, `05`
- BE-01 (HIGH/opus): unify boot vs vault-swap (~200 dup lines, already diverged). BE-02 (HIGH/opus): fix teardown order (DB closed before MCP stops) + failed-swap recovery (**owner decision**: reopen previous vault vs error page).
- DI-05 (MED/opus): on migration `StateRolledBack`, attempt rebuild rather than serve new code on old schema (strict ladder: apply → rebuild → give up).
- OPS-02 (HIGH/opus): make per-vault file logging real (every "check the log" pointer currently targets a never-written file). BE-05 (MED): fix `api.BootBanner` data race. BE-06 (MED): replace error-string equality with sentinel. BE-08 (MED): consolidate registry mutation / double app.json write. OPS-04 (MED): config precedence (**owner decision**).

**H-FRONTEND** — `04`, `08`
- FE-01 (HIGH/opus): module-singleton editor callbacks break under keep-alive multi-tab. FE-02/FE-04/FE-05/FE-06/FE-03: one shared tree/note store + derived note index + one event bus; removes per-tab copies and races. PERF-01/PERF-02 are the measured perf depth of FE-02/FE-04 — same fix.

**H-BACKEND** — `03`, `07`, `08`
- BE-03 (MED/opus): slim the fat/leaky Index port. BE-04 (MED): remove `s.index.(*index.Indexer)` downcasts. BE-07 (MED) + DUR-06 (MED): de-triplicate bulk-rewrite two-phase logic and make it crash-safe. BE-10 (LOW): drop the hand-mounted `GET /files` shadowing the generated handler. PERF-03 (MED): derive folders from DB, keep disk walk only for empty-folder discovery (pairs with DUR-01). PERF-04 (MED/opus): reuse goldmark parsers, batch reconcile writes.

**H-DURABILITY** — `07`, `05`
- DUR-03 (MED): in-app soft-delete restore + retention (**owner decision** on retention policy). DUR-07 (MED): backup/version tooling (**owner decision** on approach). DUR-08 (LOW): clean orphaned `*.tmp.*`. OPS-03 (MED): `scripts/port.sh` resolves a Phase-9-deleted path (**owner decision**: real port.sh vs `JASPER_PORT`). OPS-05 (MED): `jasper doctor` 0700-vs-0755 contradiction + raw-SQL reimplementation (**owner decision**, overlaps SEC-07). OPS-06 (LOW): rename phase-keyed E2E corpus + fix stale CLAUDE.md (note: `.golangci.yml` is repo-root not `backend/`; the "golangci-lint v1.62+" line is stale — it's v2).

---

## Owner decisions to resolve (at `/gsd:discuss-milestone` or per-phase `/gsd:discuss-phase`)

1. **SEC-01/02** — allowed-Host configuration model, especially for `--bind` LAN mode.
2. **DI-04** — versioning: explicit opaque `etag` field vs nanosecond mtime everywhere.
3. **DUR-01** — external-change detection: fsnotify watcher vs periodic poll (and WSL `/mnt/c` inotify limits).
4. **BE-02** — failed-swap recovery: reopen previous vault vs serve an error page.
5. **OPS-04** — config precedence: wire listen-port to `app.json.ServerPort` vs delete the dead app-level fields.
6. **OPS-05** — `.jasper` permissions: 0700 vs 0755 (lifecycle's sync-tool argument favors 0700).
7. **OPS-03** — dev port: make `port.sh` real vs simplify to `JASPER_PORT`.
8. **DUR-03 / DUR-07** — soft-delete retention policy; backup/version approach.

## Out of scope

- **FE-08** (per-row Proxy) and the callouts-architecture check → fold into **v1.2** (it reworks the tree/editor surfaces anyway). Not part of v1.3.
- **PERF-05..09** and any residual LOW items → `/gsd:capture` to the backlog; `/gsd:review-backlog` to promote when touching neighboring code.

## Verification & platform notes (carry into phases)

- Security attack-paths (Host/Origin/CSRF) must be asserted in **Go `httptest`** — a browser can't forge `Host`/`Origin` (forbidden headers), which is why prior CSRF work couldn't prove it in Playwright. Playwright covers the happy path only.
- DUR-04 must be tested on a **case-sensitive filesystem**; the fsnotify path must be validated under **WSL2** (inotify on `/mnt/c` is unreliable).
- Every fix is TDD/red-green where a behavior is asserted; the OPS-01 CI gate (`go test -race`) now enforces the net.

# Jasper Architecture Review — 2026-07-01

Principal-level audit of the full codebase (backend Go, frontend React, OpenAPI contract, sync flow, config/lifecycle, tooling). Four parallel deep-dives, cross-corroborated, with the highest-severity claims independently re-verified against source before writing this up.

**Verdict:** the architecture's bones are good — spec-first typing is real, the file-FIRST save contract is honored on every service write path, wshub locking is correct, fsstore is solid, path-traversal is closed, the SQLite tuning is right, and the stated performance NFRs are measurably met. The serious problems cluster in five places: (1) **derived-state maintenance on the interactive save path** (FTS and the title registry silently rot), (2) **the conflict-safety machinery exists but is bypassed** on the exact paths it was built for — which is also the root of the app's worst **data-loss** exposure once you account for external sync, (3) **the vault hot-swap lifecycle** (duplicated boot code, unsafe teardown ordering, a brick-the-server failure mode), (4) **nothing in CI enforces anything**, and (5) **the loopback security posture is defeated by one missing control** — no Host-header validation, enabling DNS-rebinding exfiltration of all notes. A recurring meta-cause: several bugs survived because documentation asserted the intended behavior and no automation checked it.

Security, durability, and performance each got a dedicated pass after the initial four (files 06–08). Net: security did real work and the core guarantees hold (one HIGH: Host validation); durability is solid *except* in the "your other tools also touch the vault" dimension (no filesystem watcher — the biggest trust gap for the self-host-with-sync use case); performance meets its NFRs today, with the one scaling risk being the per-tab tree fan-out.

## Files

| File | Theme |
|------|-------|
| [01-data-integrity.md](01-data-integrity.md) | Save path correctness: FTS wipe, dead title registry, bypassed optimistic locking, version-clock mismatch, migration rollback semantics |
| [02-sync-and-events.md](02-sync-and-events.md) | Multi-session sync: silent mutations, reconnect gaps, MCP/REST divergence, untyped WS envelope |
| [03-backend-architecture.md](03-backend-architecture.md) | Lifecycle duplication, hot-swap brick, port design, layering violations, globals |
| [04-frontend-architecture.md](04-frontend-architecture.md) | Keep-alive tab-model fallout, hand-rolled caches/buses, composition-root sprawl |
| [05-config-and-operations.md](05-config-and-operations.md) | CI gap, dead logging, config sprawl, doctor contradictions, test organization |
| [06-security.md](06-security.md) | DNS rebinding / no Host check, WS origin, CSRF-via-GET, SVG serving, symlink parity, perms — plus what's verified secure and how to test the fixes |
| [07-durability.md](07-durability.md) | External-edit desync (no watcher), overwrite-on-save, NFC/case drift on WSL, soft-delete restore, bulk-rewrite crash, backup tooling |
| [08-performance.md](08-performance.md) | NFRs measured & met; useFileTree fan-out, tab-title DFS, double tree-walk, reconcile transactions — and corrections to the frontend audit |
| [MILESTONE-hardening.md](MILESTONE-hardening.md) | **Ready-to-ingest `MILESTONE-CONTEXT.md` for the v1.3 "Hardening" milestone** — goal, scope, 7-phase REQ-ID breakdown, owner decisions. Feed to `/gsd:new-milestone` after v1.2 wraps. |
| [GSD-INTAKE.md](GSD-INTAKE.md) | How to route findings into the `/gsd:*` flow: profiles → entry points, the (now v1.3) Hardening milestone sketch with shipped items marked, owner decisions |

## All findings at a glance

Priorities: HIGH / MEDIUM / LOW (nitpicks were found and dropped). Executor: **sonnet** = mechanical, fully specified in the finding; **opus** = needs investigation or design judgment. Effort: S / M / L.

| ID | Finding | Priority | Executor | Effort |
|----|---------|----------|----------|--------|
| DI-01 | Interactive saves silently wipe FTS body content; reconcile can never heal it | HIGH | sonnet | M |
| DI-02 | Registry title index dead after every restart — backlink resolution silently broken | HIGH | sonnet | M |
| DI-03 | Autosave / keepalive / reconnect saves never send If-Match — optimistic locking bypassed | HIGH | opus | M |
| DI-04 | If-Match is check-then-act (no lock); `updated_at` is two incompatible clocks | MEDIUM | opus | M |
| DI-05 | Migration `StateRolledBack` boots new code on an old schema | MEDIUM | opus | M |
| SY-01 | Daily-note create, /files upload/delete/move, attachment upload never broadcast | HIGH | sonnet | M |
| SY-02 | WS reconnect refreshes the tree only — open notes, tags, backlinks, grants stay stale | HIGH | sonnet | M |
| SY-03 | MCP `move_note` skips wiki-link rewriting — LINKS-07 lives in the REST handler | HIGH | opus | M |
| SY-04 | `WSEnvelope.payload` untyped in spec; hand-built/hand-cast both ends; drift already shipped | MEDIUM | sonnet | M |
| SY-05 | MCP `update_note` misdocuments omitted `if_match` as safe; misreports `force_write` | MEDIUM | sonnet | S |
| BE-01 | Boot vs vault-swap: ~200 duplicated lines, already diverged (ACL-before-swap violated on boot) | HIGH | opus | L |
| BE-02 | Hot-swap partial failure bricks the server; teardown closes DB before MCP drains | HIGH | opus | M |
| BE-03 | `Index` port is fat (17 methods) and leaky (adapter receives domain `*Registry`) | MEDIUM | opus | L |
| BE-04 | API handlers downcast the port to `*index.Indexer` | MEDIUM | sonnet | M |
| BE-05 | `api.BootBanner` is an unsynchronized mutable package global (data race) | MEDIUM | sonnet | S |
| BE-06 | `ErrSwitchInProgress` matched by error-string equality | MEDIUM | sonnet | S |
| BE-07 | Bulk-rewrite trio triplicates ~65 lines of two-phase write/rollback logic | MEDIUM | sonnet | M |
| BE-08 | Vault open/switch registry mutation duplicated in 3 places; app.json written twice per open | MEDIUM | sonnet | S |
| BE-09 | MCP error mapping is a drifting copy of the API's | LOW | sonnet | S |
| BE-10 | Hand-mounted `GET /files` shadows a complete, dead generated handler | LOW | sonnet | S |
| BE-11 | `Error.code` is an untyped free string; client string-matches by hand | LOW | sonnet | S–M |
| FE-01 | Module-level singleton editor callbacks break under keep-alive multi-tab | HIGH | opus | M |
| FE-02 | `useFileTree` is a hand-rolled server cache with per-instance tree copies | MEDIUM | sonnet | M |
| FE-03 | App.tsx is the tab-lifecycle engine, wired through render-phase-mutated refs | MEDIUM | opus | L |
| FE-04 | Six duplicated recursive tree walkers; no derived note index | MEDIUM | sonnet | S–M |
| FE-05 | Global `saveState` slice written by every keep-alive pane — indicator races across tabs | MEDIUM | sonnet | S |
| FE-06 | Five hand-rolled pub/sub buses; WS dispatcher hard-couples to every feature | MEDIUM | sonnet | M |
| FE-07 | EditorPane save orchestration tangled in the component; keepalive PUT duplicated as raw fetch | MEDIUM | opus | M–L |
| FE-08 | Per-row-per-render `Proxy` with double cast in FileTree row adapter | LOW | sonnet | S |
| OPS-01 | No CI runs tests, lint, or the gen-check drift guard | HIGH | sonnet | S |
| OPS-02 | Per-vault file logging is dead code; every "check the log" pointer targets a file never written | HIGH | opus | M |
| OPS-03 | `scripts/port.sh` resolves a config path the product deleted in Phase 9 | MEDIUM | sonnet | S |
| OPS-04 | Config sprawl: dead override fields, phantom `~/.jasper/.jasper/`, bind resolution reads wrong file | MEDIUM | opus | M |
| OPS-05 | `jasper doctor` fails healthy installs (0700 vs 0755 contradiction); copy-pasted diagnostics | MEDIUM | sonnet | M |
| OPS-06 | 15.8k-line E2E corpus keyed by phase number; CLAUDE.md stale in four load-bearing places | LOW | sonnet | L |
| SEC-01 | No Host-header validation → DNS-rebinding exfiltrates all note content (drive-by) | HIGH | opus | M |
| SEC-02 | WebSocket DNS-rebinding (coder/websocket same-Host shortcut bypasses OriginPatterns) | HIGH | opus | S |
| SEC-03 | State-changing GET: `/daily-notes/{date}` creates files cross-origin | MEDIUM | opus | S |
| SEC-04 | User-supplied SVG served inline in the app origin (CSP-mitigated today) | MEDIUM | sonnet | S |
| SEC-05 | Symlink parity gap: REST file/attachment + MCP read_attachment skip fsstore's EvalSymlinks | MEDIUM | sonnet | M |
| SEC-06 | MCP listener (6684) has no Host/Origin validation | LOW–MED | opus | S |
| SEC-07 | Data dir / index DB world-readable (0755); overlaps OPS-05 | LOW | sonnet | S |
| SEC-08 | Backend emits unescaped `excerpt_html`; only frontend DOMPurify saves it | LOW | sonnet | S |
| DUR-01 | No external-change watcher — vault silently desyncs under sync/second editor | HIGH | opus | M–L |
| DUR-02 | Open editor overwrites concurrent external edits (external-edit facet of DI-03) | HIGH | opus | M |
| DUR-03 | Soft-delete has no in-app restore or retention | MEDIUM | sonnet/opus | M |
| DUR-04 | Filename case/NFC-NFD drift hides externally-created notes on WSL | MEDIUM | opus | M |
| DUR-05 | Change detection is mtime-seconds only; no size/checksum comparison | MEDIUM | sonnet | S |
| DUR-06 | Crash mid bulk-rewrite leaves vault half-applied (durability facet of BE-07) | MEDIUM | opus | M |
| DUR-07 | No backup/version tooling; overwrites unrecoverable | MEDIUM | sonnet/opus | M |
| DUR-08 | Orphaned `*.tmp.*` files left on crash | LOW | sonnet | S |
| PERF-01 | useFileTree fan-out: 3 subscribers/tab, each a full tree copy + walk (perf depth of FE-02) | HIGH | opus | M |
| PERF-02 | `titleForTab` full-tree DFS per tab per render (FE-04 measured) | MEDIUM | sonnet | S |
| PERF-03 | `GET /tree` does two full FS walks per request | MEDIUM | sonnet/opus | M |
| PERF-04 | Cold reconcile: 3 transactions/file + fresh goldmark parser per call | MEDIUM | opus | M |
| PERF-05..09 | LIKE scan, FTS N+1, no code splitting, quick-switcher reflatten, no mmap PRAGMA | LOW | sonnet | S |

## Suggested sequencing

1. **OPS-01 first** (an afternoon). Every fix below deserves a CI net under it.
2. **The data-integrity arc: DI-01 → DI-02** — user-visible correctness, small blast radius, sonnet-ready, regression tests specified.
3. **The conflict-safety arc: FE-07 → DI-03 → SY-02** — one opus engagement. FE-07 extracts the save orchestration; DI-03 threads If-Match through it; SY-02 makes reconnect a revalidation barrier. These three interlock: SY-02 is how events get lost, DI-03 is what makes lost events destructive.
4. **FE-01** — the latent wrong-folder bug under multi-tab. Opus; lands best after FE-02/FE-04 exist (callbacks can then read from the shared tree store), but don't block on them if scheduling forces it.
5. **The lifecycle arc: BE-01 + BE-02 together** — BE-01's extraction is the natural vehicle for BE-02's teardown reorder and recovery handler. Opus, the largest single engagement.
5b. **SEC-01 + SEC-02** (one Host-allowlist middleware closes both) and **DUR-01** (the fsnotify watcher) — the two highest-value net-new controls from the security/durability passes; DUR-01 also enables SY-02 and PERF-03. Verify SEC-01/02 with Go integration tests, not Playwright (see `06-security.md`).
6. **SY-01, SY-03** — write-surface parity (independent of the above).
7. **Everything MEDIUM that's sonnet-tagged** (BE-04..08, FE-02/04/05/06, SY-04/05, OPS-03/05) — each is independent, fully specified, and safe to run as an isolated task.
8. LOW items opportunistically, when touching the neighboring code.

## Verified sound (audited, no finding)

To save the next reviewer the trip: file-FIRST ordering is honored in `Service.Update/Create/Delete/Move`; wshub broadcast-under-RLock with non-blocking sends and `closeSlow` is race-free; WS origin-session filtering is correct end-to-end (including MCP's empty origin notifying all tabs); fsstore canonicalization and no-overwrite guards are consistent; loopback binding is enforced at startup; MCP write tools do share `notes.Service` (create/update/delete broadcast correctly — `move` is the exception, SY-03); `SettingsDialog.tsx` and `TabStrip.tsx` are large but cohesive; Playwright helpers (`spawnJasper`, ephemeral ports) are properly centralized.

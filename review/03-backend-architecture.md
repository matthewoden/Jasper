# 03 — Backend Architecture: Lifecycle, Ports, Layering

The service layer and fsstore are in good shape; file-FIRST ordering is honored everywhere it should be. The structural debt concentrates in `internal/app`'s lifecycle (duplication that has already produced real divergence bugs) and in a handful of places where the port abstraction is bypassed or leaks.

---

## BE-01 — Boot vs vault-swap: ~200 duplicated lines, already diverged in ways that are bugs

**Priority:** HIGH · **Executor:** opus · **Effort:** L · *(found independently by two audit passes)*

### Evidence

`backend/internal/app/lifecycle.go` — `bootPerVaultSubsystems` (143-372) and `initVaultSubsystemsOnly` (374-535) are near-clones of the same sequence: EnsureDataDir → seed → mkdir → preflight → sqlite.Open → migration runner → frontmatter scaffold → seed grants → reconcile → hub → service → registry hydrate → apiServer wiring (6 setters) → identical chi router block (314-331 vs 490-505) → MCP start. The divergences are not policy, they're drift:

- **The documented invariant is violated on the boot path.** The switch path documents: "SetMcpACL must be called before a.handler.Swap(r) so the first non-503 response always reflects vault B's ACL" (`lifecycle.go:521-531`). The boot path does the opposite: `a.handler.Swap(r)` at line 332, MCP config load + `SetMcpACL(acl)` at 334-352 — *after* the swap.
- **Error handling differs by construction:** boot serves static error pages via `serveStartupError` (219-241); switch returns bare wrapped errors (429-431) — which feeds BE-02's brick state (a disk-full *target* vault bricks the server instead of showing disk-full.html).
- **Resource cleanup differs:** boot defers `pair.Close()` + MCP shutdown (197, 357-370); the switch path's `pair` leaks if a later step in the function fails (no defer/cleanup on error).
- The switch path never re-initializes the file logger that teardown closed (see OPS-02).
- The "9-step sequence" exists only as a comment (90-111); every new per-vault subsystem must be added twice and will drift again.

### Fix

Extract a single `func (a *App) buildVaultStack(ctx) (*vaultStack, error)` returning `{pair, indexer, runner, hub, notesSvc, apiServer, router, mcpShutdown}`, structured as a list of named steps, with cleanup-on-error inside (close pair/MCP if a later step fails). Return a typed `bootFailure{kind: diskFull | unrecoverable | generic}` so each caller maps failures to its own presentation:

- `bootPerVaultSubsystems` = `buildVaultStack` + static-error-page policy + swap + serve.
- `initVaultSubsystemsOnly` = `buildVaultStack` + plain-error policy (or recovery handler, per BE-02) + swap.

Fix the ordering in both: MCP ACL wiring **before** `handler.Swap`, matching the switch path's documented invariant.

### Done when

Existing lifecycle tests green; new tests: (a) boot with MCP enabled — first request after swap reflects the ACL; (b) `buildVaultStack` failure at each step leaks no open pair/listener (assert via `lsof`-style check or close-tracking fakes).

---

## BE-02 — Hot-swap partial failure bricks the server; teardown closes the DB before MCP stops accepting writes

**Priority:** HIGH · **Executor:** opus · **Effort:** M · *(two audit passes converged on this from different directions)*

### Evidence

**Brick:** `backend/internal/app/lifecycle_vault_swap.go:94-103`:
```go
a.handler.Swap(nil)
if tearErr := a.tearDownPerVaultSubsystems(); ...
a.cfg.DataDir = canonical
if bootErr := a.initVaultSubsystemsOnly(ctx); bootErr != nil {
    return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: open new vault: %w", bootErr)
}
```
If `initVaultSubsystemsOnly` fails (foreign vault's migrations fail, disk full, sqlite open error — all plausible), the function returns with the old vault torn down, `a.cfg.DataDir` already mutated, and the handler still `nil` — `swappableHandler.ServeHTTP` (`swappable_handler.go:30-36`) serves `503 "no handler"` for **every request forever**, including the vault picker that could rescue the user.

**Teardown order:** `lifecycle_vault_swap.go:130-158` closes the DB pair *first*, then shuts down MCP with a 5s grace period *third*. During that window, in-flight MCP tool calls (create/update via `notes.Service` → indexer → the closed pair) hit a closed DB. The V6 write-drain (`inFlightWrites`) only covers HTTP API writes (`lifecycle.go:304,485`); MCP handlers never touch it, and port 6684 keeps accepting until step 3. An MCP write racing a switch can half-complete: file-FIRST write to old-vault disk succeeds, index upsert fails → old vault's index silently stale. Note CLAUDE.md documents this order ("DB pair → indexer → MCP → logger") as if intentional — the docs blessed the hazard.

**Drain ordering:** `handler.Swap(nil)` happens *after* the 2s `inFlightWrites.Wait()` (78-94), so new writes keep `Add`ing during the drain — documented `sync.WaitGroup` misuse (`Add` concurrent with `Wait` at possibly-zero counter) and a drain that may never converge.

**Hub:** old `wshub.Hub` has no close/drain at all (`hub.go` exposes only Broadcast/register/unregister/ClientCount) — clients that miss `vault.switched` stay attached to a dead hub.

### Fix

1. **Recovery on failed swap:** capture the previous `DataDir` before mutation; on `initVaultSubsystemsOnly` failure, attempt to reopen vault A (best-effort); if that also fails, `a.handler.Swap(errorHandler)` that serves the startup-error page / vault picker instead of nil. Never leave nil installed.
2. **Reorder teardown:** (1) MCP shutdown (stop accepting on 6684 + drain), (2) drain `inFlightWrites` — and register MCP write tools with the same WaitGroup, (3) hub: final broadcast + `CloseAll()` (add it), (4) `pair.Close()`, (5) logger.
3. **Reorder drain:** `handler.Swap(nil-or-503-handler)` *before* `inFlightWrites.Wait()` so no new writers enter during the drain.
4. Update the CLAUDE.md ordering claim.

### Done when

E2E: switch to a vault with a deliberately corrupt DB → UI shows an error and the picker still works (no permanent 503). Go test: MCP write racing `SwitchVault` either completes fully or gets a clean "switching" error — never a closed-DB internal error.

---

## BE-03 — The `Index` port is fat (17 methods) and leaky: the adapter reaches back into domain state

**Priority:** MEDIUM · **Executor:** opus · **Effort:** L

### Evidence

- `backend/internal/notes/ports.go:113-207` — one interface spans CRUD projection, path-prefix batch ops, tags, backlinks, and two search APIs; `nopIndex` needs ~50 lines of stubs (`service.go:916-967`).
- Worst leak: `SyncBacklinks(ctx, sourceID uuid.UUID, sourcePath string, refs []markdown.WikiLinkRef, registry *Registry, content []byte) error` (`ports.go:163-164`) — the SQLite adapter receives the domain's concrete `*Registry` and calls `registry.FindByTitle` from *inside the adapter* (`index/backlinks.go:62`), plus raw note content for excerpt building. Title→ID resolution — domain logic — lives in the persistence layer, which is exactly why DI-02 hid in `index/` instead of `notes/`.

### Fix

1. Resolve in the service: `Service.Update` computes `resolved []BacklinkEntry{TargetTitle, TargetID *uuid.UUID, Excerpt}` using its own registry + a `notes`-package excerpt builder. The port shrinks to `SyncBacklinks(ctx, sourceID uuid.UUID, rows []BacklinkEntry) error`.
2. Then split `Index` into role interfaces consumed where needed (`NoteIndex`, `TagIndex`, `BacklinkIndex`, `SearchIndex`) — `api.Server` only needs the read subset.
3. Reconcile keeps its own resolution path (it runs registry-less by design).

Sequence after DI-02 (they touch the same resolution code; DI-02 is the urgent, small half).

---

## BE-04 — API handlers bypass the port with `s.index.(*index.Indexer)` downcasts

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** M

### Evidence

`backend/internal/api/tree_handler.go:34`, `admin_reindex_handler.go:17,119`:
```go
idx, ok := s.index.(*index.Indexer)
```
to reach `BuildTree` and `Reconcile`, which aren't on the `notes.Index` port. The tree — the app's primary read path — is untestable against a fake index, and `api` hard-depends on the concrete adapter, defeating the port's purpose.

### Fix

Define consumer-side interfaces in `api` (`type TreeBuilder interface { BuildTree(ctx) (*index.Tree, error) }`, `type Reconciler interface { Reconcile(ctx, mode) (int, error) }` — moving the `Tree` type to a neutral package if the `index` import bothers), add `Server.SetTreeBuilder` / `SetReconciler` setters wired in lifecycle, delete the type assertions.

### Done when

No `.(*index.Indexer)` assertions under `internal/api`; a tree-handler unit test runs against a fake `TreeBuilder`.

---

## BE-05 — `api.BootBanner` is an unsynchronized mutable package global (data race)

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** S

### Evidence

`backend/internal/api/vault.go:74` (`var BootBanner string`), written by `lifecycle.Run` (`lifecycle.go:123`), `OpenVault` (`lifecycle.go:660`), and request handlers `PostVaultOpen`/`PostVaultCreate` (`vault.go:228,356`); read by `GetVaultRecent` (`vault.go:154`). Concurrent requests read/write with no synchronization — `go test -race` flags it under concurrent requests — and it leaks state across `App` instances in tests.

### Fix

Replace with a field on `api.Server` behind `atomic.Pointer[string]` (setter `SetBootBanner`), wired from lifecycle; delete the global. Fold in BE-08's related cleanup (handlers should not write banner state at all — that belongs to the App methods).

---

## BE-06 — `ErrSwitchInProgress` matched by error-string equality

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** S

### Evidence

`backend/internal/api/vault.go:31,405`: `if err.Error() == switchInProgressMsg` against `app.ErrSwitchInProgress` (`lifecycle_vault_swap.go:17`) — because `api` can't import `app` (cycle). Any `%w` wrapping or message edit silently turns the 409 contention response into a 400 `switch_failed`, breaking the frontend's retry logic with no compile-time or test signal.

### Fix

Move the sentinel to a leaf package both sides import — `internal/vault` fits (`vault.ErrSwitchInProgress`); `app.SwitchVault` returns it; handler uses `errors.Is`. Apply the same pattern if `ErrAlreadyOpen` (`lifecycle.go:35`) ever needs wire mapping.

---

## BE-07 — The bulk-rewrite trio triplicates ~65 lines of two-phase write/rollback logic

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** M

### Evidence

`service.go:709-774` (`RenameTagAcrossVault`), `:780-838` (`DeleteTagAcrossVault`), `:851-914` (`RenameRewriteWikilinks`) are structurally identical: query carriers → read+rewrite in memory → FS write pass with rollback-on-failure → non-fatal SQL pass → sorted-UUID broadcast. Three copies of the rollback loop means a rollback-semantics fix (e.g., DI-04's locking) must land three times.

To be explicit about scope: a full CRUD split of `notes.Service` is **not** recommended — CRUD + registry + events belong together per the file-FIRST contract; splitting them would spread the invariant. This extraction is the right-sized remedy.

### Fix

New `backend/internal/notes/bulk_rewrite.go`:
```go
func (s *Service) rewriteAcrossVault(ctx, carriers []NoteSummary,
    rewrite func([]byte) []byte, sqlPass func(ctx) error,
    event string, payload func(ids []uuid.UUID) map[string]any) ([]uuid.UUID, error)
```
encapsulating read/write/rollback/broadcast; the three public methods become ~15-line wrappers. While in the file, fix the stale doc comment on `Delete` (`service.go:378-385` claims "index.Delete runs FIRST" while the code correctly trashes the file first).

---

## BE-08 — Vault open/switch registry mutation lives in 3 places; app.json written twice per open

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** S

### Evidence

`api/vault.go` `PostVaultOpen` does `LoadAppJSON → TouchOpened → SaveAppJSON → BootBanner=""` (~206-228), then calls `App.OpenVault` (`lifecycle.go:640-660`) which does the same load/touch/save/banner-reset again — two full read-modify-write cycles of `app.json` per open, the handler's write immediately re-read and re-written. `SwitchVault` holds a third copy split across before/after boot (`lifecycle_vault_swap.go:51-65,105-113`). The displayName-lookup loop over `RecentVaults` is additionally copy-pasted in ≥5 places (`status.go:80-86`, `lifecycle.go:649-655`, `lifecycle_vault_swap.go:59-65`, `lifecycle_vault.go:44-49,68-74`, `api/vault.go:215-221`).

### Fix

Registry mutation belongs to the App methods only: `PostVaultOpen` validates + calls `OpenVault` and reads the returned entry (mirror `SwitchVault`'s signature — have `OpenVault` return `vault.RecentVaultEntry`). Add `state.DisplayNameFor(path)` on the app-state type, replacing the 5 loops. Banner handling moves per BE-05.

---

## BE-09 — MCP error mapping is a drifting copy of the API's

**Priority:** LOW · **Executor:** sonnet · **Effort:** S

### Evidence

`api/errors.go:16-37` (`mapServiceErrorToWire`) vs `mcp/tools.go:333-344` (`mapCreateNoteErr`). The MCP copy handles only `fs.ErrExist`/`ErrCaseCollision`/`ErrInvalidContent`; `fsstore.ErrParentNotFound` (create in a nonexistent folder — an easy AI-client mistake) falls through to `"internal: create_note: ..."`, and `update_note`/`move_note` pass raw wrapped errors. The dual sentinel taxonomy itself (`notes.Err*` + `fsstore.Err*`) is fine — it's centrally mapped on the API side; the problem is the second, drifting copy.

### Fix

Export a shared classifier next to the sentinels — `notes.ClassifyError(err) (code string, ok bool)` — consumed by both `api.mapServiceErrorToWire` and the MCP tool wrappers; extend MCP coverage to `ErrParentNotFound`, `ErrNotFound`, `ErrCycle`.

---

## BE-10 — Hand-mounted `GET /files` shadows a complete, tested, dead generated handler

**Priority:** LOW · **Executor:** sonnet · **Effort:** S

### Evidence

`app.go:205` and `lifecycle.go:329,503` register `r.Get("/files", apiServer.ServeFile)` *after* `api.HandlerFromMux`, exploiting chi last-registration-wins (documented at `files.go:410-414`). The shadowed strict `GetFile` (`files.go:18-81`) remains a full implementation with its own inline traversal checks — dead code that looks live. Behavior also diverges from spec: `openapi.yaml:412-415` promises `application/octet-stream`; the live route returns sniffed types + an SVG override (`files.go:453-456`). (`/ws` uses the same pattern but is honestly documented in the spec, `openapi.yaml:1008-1011`; `/files` is not.)

### Fix

Gut the strict `GetFile` to delegate to the shared `resolveFileUnderNotes` + a common serve helper (deleting the duplicate traversal pipeline), and document the manual handler + real content-type behavior in the `/files` spec entry, mirroring `/ws`.

---

## BE-11 — `Error.code` is an untyped free string; the frontend string-matches codes by hand

**Priority:** LOW · **Executor:** sonnet · **Effort:** S–M

### Evidence

`openapi.yaml:2002-2011` — `code: type: string` with only an example; the real vocabulary lives in `api/errors.go` and handler literals. Client does ad-hoc matching: `EditorPane.tsx:312` (`error.code === "case_collision"`), `EditorPane.tsx:667` (`staleErr.code === "stale_write"` via hand-written cast, since the 409 union isn't narrowed — `POST /notes`' 409 means two different things, `openapi.yaml:76`). Only `StaleWriteError` and `VaultSwitchInProgressResponse` enum their codes.

### Fix

Add an `ErrorCode` enum to the spec, reference it from `Error.code`; where one status carries two meanings, give each its own response schema so openapi-typescript narrows the union and the `as` casts in EditorPane can be deleted. A backend code rename then breaks the frontend build instead of production branching.

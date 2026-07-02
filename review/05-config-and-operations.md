# 05 — Configuration, Operations, and Tooling

A recurring pattern in this file: **documentation asserted the intended behavior, nothing verified it, and the code drifted** — the dead log path, the ghost config file in port.sh, the doctor/lifecycle permissions contradiction, and four stale load-bearing claims in CLAUDE.md all survived for the same reason OPS-01 exists.

---

## OPS-01 — No CI runs tests, lint, or the gen-check drift guard

**Priority:** HIGH · **Executor:** sonnet · **Effort:** S · **Do this first — everything else in the review deserves a net under it.**

### Evidence

- `.github/workflows/` contains exactly one workflow: `install-validation.yml` (the docker systemd install harness). Nothing runs `go test ./...`, `npm test`, `make lint`, or `make gen-check`.
- The only enforcement of gen-check/lint is `lefthook.yml` pre-commit — and project memory records that GSD executors routinely commit with `--no-verify` (sandboxed lefthook fails), so hooks are bypassed in exactly the workflow that produces most commits.
- CLAUDE.md claims "GitHub Actions (CI): Build + test on macOS, Linux, Windows" — this does not exist.

### Why it matters

The spec/generated-code lock ("the two are locked in sync") has no server-side guard: a commit editing `api/openapi.yaml` without regenerating lands on main silently. The whole spec-first architecture hangs on a check that only runs where hooks happen to fire.

### Fix

`.github/workflows/ci.yml`, on push/PR to main, two jobs reusing existing Make targets so local/CI stay zero-drift:
- **backend:** setup-go 1.25 → `make gen-check` → `cd backend && go test ./...` → golangci-lint action (config already at `backend/.golangci.yml`).
- **frontend:** setup-node 22 → `npm ci` → `npm test -- --run` → `npx eslint .` → `tsc -b`.

Consider `go test -race` in the backend job — BE-05 is a real race it would catch. Playwright E2E can stay out of the required path initially (slow, spawns binaries); add as a non-blocking job later.

### Done when

A PR that edits `api/openapi.yaml` without regenerating fails CI; a failing Go or vitest test blocks merge.

---

## OPS-02 — Per-vault file logging is dead code; every "check the log" pointer targets a file that is never written

**Priority:** HIGH · **Executor:** opus · **Effort:** M

### Evidence

- The only production call to `jlog.NewFileLogger` is `backend/internal/app/lifecycle.go:148-149`, guarded by `if a.cfg.Logger == nil`. But `cmd/jasper/serve.go:174` always sets `Logger: log` (a stderr TextHandler, line 66) — the guard never fires; `<vault>/.jasper/logs/jasper.log` is never created by `jasper serve`.
- Yet that path is the advertised diagnostic surface: `migrate.Runner` embeds `vault.LogsPath` in every `Status` (`runner.go:122,129,141...`), the startup error page tails it (`lifecycle.go:73,78` — `tailLog(logsPath, 20)`), and `unrecoverable.html` is built from it (`lifecycle.go:236`).
- Three divergent log locations: (a) `<vault>/.jasper/logs/jasper.log` — never written; (b) `<dataDir>/logs/` — the installer's launchd/systemd stdout redirect (`installer/installer.go:61`, `launchd_template.go:27-30`); (c) `jasper doctor` probes a third: `checkLogWritable` (`doctor.go:340`) joins `dir + "logs"`, not `vault.LogsDir` (`dir + ".jasper/logs"`).
- After a hot-swap, `tearDownPerVaultSubsystems` closes `fileLogCloser` (`lifecycle_vault_swap.go:150-155`) but never resets `a.cfg.Logger` — if the file logger ever *were* active, post-switch logs would write to a closed file.

### Why it matters

The failure UX is built around "read the log at LogsPath" — on a migration failure or unrecoverable boot, the user is pointed at a file that doesn't exist, and doctor validates writability of a directory nothing writes to.

### Fix

1. In the vault-stack boot (single site after BE-01's extraction), always construct the file logger and fan out via a multi-handler (stderr + file) — replace the nil-guard semantics ("caller may inject a logger" becomes "caller injects the *console* handler; the vault file handler is always added per-vault").
2. Recreate the file handler per vault on swap (fixing the closed-file hazard).
3. Make `vault.LogsDir` the single advertised log location; point the installer templates' stdout redirect somewhere clearly secondary (bootstrap-only) or align it; fix `doctor.go:340` to use `vault.LogsDir(dir)`.

Design decision needed on rotation × tee interaction (the daily-rotation logic must own the file handle) — hence opus.

### Done when

`jasper serve` against a fresh vault produces `<vault>/.jasper/logs/jasper.log` with entries; a forced migration failure's error page shows real log lines; doctor's log check probes the same path the logger writes.

---

## OPS-03 — `scripts/port.sh` resolves a config path the product deleted in Phase 9

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** S

### Evidence

- `scripts/port.sh:14`: `CONFIG="${JASPER_CONFIG:-$HOME/.jasper/storage/config.json}"`. No Go code reads or writes any `storage/` path; `frontend/e2e/phase9-uat.spec.ts:48-98` **asserts the storage/ path is never created**. Real config: `<vault>/.jasper/config.json` (`config/load.go:34-36`).
- So port.sh always prints 6683 unless `JASPER_CONFIG` is exported; consumers — `vite.config.ts:8` (execSync), `playwright.config.ts:6`, `Makefile print-port` — get the constant, and `vite.config.ts` swallows failures (`catch { PORT = "6683" }`), which is why nobody noticed.
- Documentation actively contradicts itself: `Makefile:4-5` claims port.sh returns the active vault's port (false), `.air.toml` tells users to edit the dead path, CLAUDE.md repeats it.

### Fix

Recommend **option (b): accept reality and simplify** — `port.sh` becomes `echo "${JASPER_PORT:-6683}"`; delete the false comments in Makefile/.air.toml/CLAUDE.md; document `JASPER_PORT` as the dev override. (Option (a), making it real — resolve `~/.jasper/app.json → current_vault → <vault>/.jasper/config.json → .server.port` with jq — is defensible but couples dev tooling to runtime state that changes under you mid-session.) Either way, remove the silent `catch` in vite.config.ts so future breakage is visible.

---

## OPS-04 — Config sprawl: dead override fields, a phantom `~/.jasper/.jasper/config.json`, and bind resolution reading the wrong file

**Priority:** MEDIUM · **Executor:** opus (one precedence decision) then sonnet · **Effort:** M

### Evidence

1. **Dead fields advertising an override chain that doesn't exist:** `vault/types.go:19-21` defines `ThemeBootstrap`, `MCPGlobalEnabled` ("app-level kill-switch"), `ServerPort` ("app-level override") on `AppState` — zero readers or writers anywhere.
2. **Self-referential path:** per-vault `config.json` persists `Server.DataDir` = the vault's own path (`vault/create.go:68`) — stale the moment the folder moves; all runtime readers fall back to `a.cfg.DataDir` anyway (`lifecycle.go:552-555`).
3. **Bind/port resolution reads the wrong file in the common path:** `serve.go:144-148` — with no `--vault` flag, `config.Load(config.DefaultDataDir(), ...)` reads `~/.jasper/.jasper/config.json` (app home treated as a vault — note the doubled `.jasper`). The active vault's `server.bind`/`server.port` is never consulted unless `--vault` is passed, contradicting serve.go's own help text. Worse, `config.Load` writes defaults on missing (`load.go:52-61`), so every bare `jasper serve` fabricates a phantom vault-shaped config inside the app home.
4. `~/.jasper` does triple duty: app home (`app.json`), legacy default data dir, phantom-config host.

### Why it matters

Three files with undefined precedence; a user editing their vault's `server.port` sees no effect; a mystery `~/.jasper/.jasper/` directory appears. The unused `AppState.ServerPort` is exactly the right home for the listen port (it's app-level — the server must bind before it knows which vault is current) — it was designed but never wired.

### Fix

One decision, then mechanical work:
1. **Decide:** listen address is app-level. Wire resolution to flag > `app.json.ServerPort` > default; delete the pre-vault `config.Load` from serve.go. Delete `ThemeBootstrap`/`MCPGlobalEnabled` (or wire them, but delete-by-default — they've had no callers for this long).
2. Drop `Server.DataDir` from the persisted per-vault config (keep wire-compat: `omitempty` + ignore-on-load).
3. Make `config.Load` never auto-write when `dataDir == AppHomePath()`.
4. Document the final precedence chain in one place (serve.go help text + CLAUDE.md).

### Done when

Fresh install: `jasper serve` creates no `~/.jasper/.jasper/`; editing the documented port setting changes the listen port; `git grep ServerPort` shows a reader.

---

## OPS-05 — `jasper doctor` fails healthy installs (0700 vs 0755 contradiction) and re-implements internals with raw SQL

**Priority:** MEDIUM · **Executor:** sonnet (after one owner decision) · **Effort:** M

### Evidence

- **Permissions contradiction:** `doctor.go:254-259` requires `.jasper` mode `0700`; `lifecycle.go:39-46 EnsureDataDir` deliberately creates `0o755` (comment defends 0755 for sync tools); `vault/create.go:63` uses `0o700`. Wizard-created vaults pass doctor; any vault whose `.jasper` came from `EnsureDataDir` (`--vault` into a fresh dir, legacy fallback) reports a spurious FAIL — and doctor's help text tells the user to chmod against the server's own convention.
- **Copy-paste diagnostics:** vault-resolution preamble duplicated in `doctor.go:69-88` and `status.go:61-72`; `checkMigrationState` (`doctor.go:270-337`) re-implements the runner's applied/pending logic with its own `sql.Open` (already drifting: it skips the filename-pattern validation the runner enforces at `runner.go:262-264`); `status.go:201-233` hand-rolls the `mcp_write_grants` query instead of reusing `mcp.ACL`.

### Fix

1. **Owner decision (flagging per project convention):** 0755 or 0700 for `.jasper`. The lifecycle comment (sync-tool compatibility) is the stronger argument; if 0755 wins, doctor should check *owner-writable*, not exact mode. Align all three sites.
2. Extract `vault.ResolveForCLI(vaultFlag) (dataDir, displayName, error)` used by doctor + status; expose `migrate.PendingMigrations(dbPath, fs)` as a read-only helper doctor calls; reuse `mcp.ACL` for the grants summary. (Pairs with BE-08's `DisplayNameFor`.)

### Done when

Doctor passes on a vault created via `--vault` into a fresh directory; migration-state check shares the runner's discovery code path.

---

## OPS-06 — 15.8k-line E2E corpus keyed by phase number; CLAUDE.md stale in four load-bearing places

**Priority:** LOW · **Executor:** sonnet · **Effort:** L (reorg) + S (docs)

### Evidence

- 30 specs named `phaseN-*.spec.ts`, 15,824 lines; `phase7-uat.spec.ts` alone is 2,345 lines; vault behavior scattered across 8 `phase8-*` files; only 2 feature-named files exist. Answering "what covers vault switching?" requires opening 8 files; assertions rot because the owning file is non-obvious.
- Dead shim still called: `helpers/binary.ts:46-48 withMcpPortLock` is a documented no-op ("New tests should NOT wrap with this") that existing specs still wrap.
- CLAUDE.md is wrong in four load-bearing places: (1) "1 worker (serial test execution)" — actual config is `fullyParallel: true, workers: 4`; (2) multi-OS CI that doesn't exist (OPS-01); (3) the `~/.jasper/storage/config.json` path (OPS-03); (4) the teardown ordering "DB pair → indexer → MCP → logger" blessed as design when it's the BE-02 hazard.
- Noted positives: `spawnJasper` is properly centralized with per-test ephemeral HTTP and MCP ports; the parallel config is healthy.

### Fix

1. One-time reorganization into feature suites — `vault.spec.ts`, `editor.spec.ts`, `tree.spec.ts`, `search.spec.ts`, `sync.spec.ts`, `setup.spec.ts`, `mcp.spec.ts` — keeping `@phaseN` tags on describe blocks for traceability. Adopt "new E2E goes into the feature file" as convention. Mechanical but large; a good isolated sonnet task with a strict "move, don't edit assertions" rule.
2. Delete `withMcpPortLock` call sites.
3. Correct the four CLAUDE.md claims — small, do it immediately with OPS-01 rather than waiting for the reorg.

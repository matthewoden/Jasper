## Project

**Jasper**

Jasper is a lightweight, self-hosted, browser-based markdown notes application — Obsidian-inspired, but without the plugin/extension surface. It runs as a native server on the user's own machine (Mac primarily, WSL close behind), serves a single-user web UI, and stores all notes as plain `.md` files on disk so the data is fully portable and recoverable. Built for the project owner and a small group of coworkers to self-host individually in environments where the broader Obsidian plugin ecosystem isn't acceptable.

**Core Value:** **Writing, searching, and organizing markdown notes in the browser feels as fluid and trustworthy as a native note-taking app — with zero plugin attack surface and full local ownership of the underlying files.**

If everything else about Jasper fails, this must work: open the browser, write notes, find them later, manage their files and folders without friction or fear of data loss.

### Constraints

- **Tech stack**: TypeScript + React + Vite (frontend), Go + `chi` or `net/http` + `modernc.org/sqlite` (backend), OpenAPI 3.1 + `oapi-codegen` for the contract. **Why**: Locked in DESIGN.md §2 after deliberation; pure-Go SQLite driver is critical to keep the binary deployable without CGo / native deps.
- **Deployment**: Native single Go binary + OS service (launchd plist on macOS, systemd unit in WSL2) is the primary install model; Docker is not the default path. **Why**: For single-user self-host on Mac/WSL, native install gives smaller footprint, no Docker daemon dependency, and simpler upgrades. Decided during init.
- **Platform priority**: macOS first, WSL close behind (validated before v1 ships). **Why**: Owner's primary dev environment is Mac; coworkers may be on either. Linux-native (non-WSL) and Windows-native are not v1 targets.
- **Security**: No plugin / extension / scripting surface — ever. Server runs locally, binds to localhost by default. **Why**: Security posture is the *reason* Jasper exists.
- **Performance**: File tree must handle 1,000+ notes without lag (virtualize if needed). Startup (migrations + incremental re-index) under 5s for <5,000 notes. **Why**: Per DESIGN.md §13 NFRs; this is the threshold for "feels native."
- **Data integrity**: All writes atomic; never truncate before confirming write success. Filesystem is source of truth, SQLite is derived. **Why**: Migration resilience and "wiping SQLite is never data loss" depend on this property.
- **Offline**: App fully functional offline once loaded; no CDN dependencies at runtime. **Why**: Self-hosted ethos; user's machine, user's data, user's network.
- **Pace**: Weekend cadence — phases sized for sittable chunks. **Why**: Owner's available time.

## Technology Stack

## Languages

- **Go** 1.25.0 - Backend language; single static binary compilation via pure-Go SQLite driver, no CGo
- **TypeScript** 5.9.0 - Frontend language; transpiles to ES2022 with strict mode enabled
- **React** 19.2.0 - UI framework; single-page app (SPA) only, no SSR
- **SQL** (embedded in migrations) - Schema definitions for FTS5, tag indexes, MCP grants tables
- **YAML/JSON** - Configuration files; frontmatter parsing in notes (YAML in markdown)
- **Markdown** - User content; parsed server-side for backlinks/tags extraction, client-side for live rendering

## Runtime

- **Go 1.25.0** - Backend; requires no runtime dependencies (pure-Go SQLite)
- **Node.js 22+** - Frontend build and test tooling only (not runtime); Vite dev server on :5173
- **npm** (pnpm-compatible lockfile format) - Frontend
- **go mod** - Backend
- Lockfiles present: `frontend/package-lock.json`, `go.sum`

## Frameworks

- **chi/v5** v5.2.5 - HTTP router; composable middleware, route grouping (`r.Route("/api/v1", ...)`), includes Logger, Recoverer, RealIP, Compress, Timeout, RequestID middleware
- **React** 19.2.0 - Component-based UI; CSR/SPA architecture
- **Vite** 8.0.0 - Build tool and dev server; Rolldown (Rust bundler) enabled; emits static dist/ that Go binary embeds
- **zustand** 5.0.12 - Lightweight client state for tabs, sidebar, active note; replaces Redux/TanStack Query
- **CodeMirror 6** (v6.0.2+) - Markdown editor; modular packages:
- **react-arborist** 3.5.0 - Virtualized file tree with drag-and-drop, inline rename, multi-select, keyboard nav
- **Radix UI** (primitives) - Headless accessible components:
- **Tailwind CSS** 4.0.0 - Utility-first styling (optional; configurable)
- **lucide-react** 0.460.0 - Icon library
- **@tanstack/react-virtual** 3.13.24 - Virtualization primitives (used alongside react-arborist)
- **coder/websocket** 1.8.14 - Server: context-first, zero deps, direct net/http upgrade; Client: mock-socket 9.3.1 for tests
- **oapi-codegen/v2** 2.7.0 - Backend codegen (generates `chi-server` + `strict-server` interfaces)
- **openapi-typescript** 7.4.0 - Frontend codegen (emits single `paths.d.ts`)
- **openapi-fetch** 0.17.0 - Frontend HTTP client (~6kB); thin wrapper over native fetch with type inference
- **goldmark** 1.8.2 - Server-side markdown parser (CommonMark-compliant, AST-walkable)
- **go.abhg.dev/goldmark/frontmatter** 0.3.0 - YAML frontmatter parsing (`---` blocks)
- **go.abhg.dev/goldmark/wikilink** 0.6.0 - `[[wiki-link]]` parsing with custom resolver
- **modernc.org/sqlite** 1.50.0 - Pure-Go SQLite driver (no CGo); compiled with FTS5, JSON1, RTree extensions
- **golang-migrate/migrate/v4** (via custom wrapper, not direct) - Embedded SQL migrations via `//go:embed`; migrations are checked in as `.sql` files in `backend/migrations/`
- **vitest** 2.1.0 - Frontend unit tests; Vite-native, jsdom environment
- **@testing-library/react** 16.0.0 - Component testing utilities
- **@playwright/test** 1.59.1 - E2E tests; spins up live binaries per test
- **Go `testing`** (stdlib) - Backend unit/integration tests via `go test ./...`
- **spf13/cobra** 1.10.1 - CLI subcommands (`serve`, `install`, `uninstall`, `status`, `doctor`)
- **kardianos/service** 1.2.4 - Cross-platform OS service registration (launchd plist on macOS, systemd unit on WSL2)
- **modelcontextprotocol/go-sdk** 1.6.0 - Official MCP SDK; embedded as second HTTP listener on port 6684; provides 6 tools (read: list_notes, read_note, search_notes, read_attachment; write: create_note, update_note, move_note, delete_note with ACL)
- **google/uuid** 1.6.0 - UUID generation for note IDs
- **fuzzysort** 3.1.0 - Fuzzy search in file tree
- **dompurify** 3.4.2 - Sanitize HTML in rendered markdown
- **date-fns** (not present; can be added) - Date formatting for daily notes (future use)
- **js-yaml** (not present; can be added) - Frontmatter parsing on frontend (low priority; server already parses)
- **log/slog** (stdlib Go 1.21+) - Structured logging (zero-dep); no external logging library
- **@lezer/highlight** 1.2.3 - Code syntax highlighting in editor

## Configuration

- No `.env` file by default; all config lives in `~/.jasper/storage/config.json` (JSON structure)
- Per-vault config at `<vault>/.jasper/config.json` (legacy format, being unified into storage)
- Vault registry at `~/.jasper/app.json` (lists recent vaults, current vault, creation dates)
- First-run wizard configures data directory, theme, daily notes, editor preferences, MCP opt-in
- `frontend/vite.config.ts` - Vite config; reads canonical port from `scripts/port.sh` (resolves `~/.jasper/storage/config.json` or defaults to 6683)
- `frontend/vitest.config.ts` - Vitest config; jsdom environment, excludes `e2e/` from unit test runs
- `frontend/playwright.config.ts` - Playwright config; baseURL = canonical port; fullyParallel with 4 workers locally / 2 in CI; retries 0 (a flake is a real bug); spawnJasper() allocates ephemeral ports + a fresh data dir per test
- `frontend/tsconfig.json` - TypeScript config; ES2022 target, strict mode, module resolution bundler
- `frontend/eslint.config.js` - ESLint flat config (v9+); extends @eslint/js + typescript-eslint + react-hooks + react-refresh
- `backend/.golangci.yml` - golangci-lint config; enables errcheck, govet, staticcheck, revive; gofumpt formatter
- `.air.toml` - Air (Go hot-reload) config; watches backend/, includes sql files, runs `go build -o ./tmp/jasper ./backend/cmd/jasper`
- `api/openapi.yaml` - OpenAPI 3.1.0 spec; single source of truth for API surface; both oapi-codegen (backend) and openapi-typescript (frontend) consume this
- `Makefile` - Task runner; targets: `gen` (both codegens), `gen-go`, `gen-ts`, `gen-check`, `build` (frontend + copy dist + backend go build), `test`, `lint`, `dev`, `perf-check`, `perf-vault`, `test-wsl-e2e`
- `lefthook.yml` - Pre-commit hook runner (parallel); commands: gen-check, lint

## Platform Requirements

- macOS: native Go 1.25.0, Node 22+, make, [optional] air for hot-reload
- WSL2 (Ubuntu/Debian): same as Linux below
- Linux: Go 1.25.0, Node 22+, make
- No Docker requirement for dev (Docker used only for fake-WSL E2E in CI)
- **macOS**: Native Go binary + launchd plist at `~/Library/LaunchAgents/com.jasper.server.plist` (per-user agent, no sudo)
- **WSL2**: Native Go binary + systemd unit at `~/.config/systemd/user/jasper.service` (requires `systemd=true` in `/etc/wsl.conf` + `loginctl enable-linger`); documented in install step
- **Deployment model**: Single static Go binary (no dependencies); invoked as `jasper serve` via service manager
- **Startup**: <5s for <5,000 notes (migrations + incremental re-index) per Phase NFRs

## Key External Dependencies

- **MCP Server** (optional, disabled by default): Exposes notes to Claude Desktop via Model Context Protocol; runs on port 6684 (loopback)
- **OS file-manager reveal** (macOS + WSL2): `open` command (Finder), `explorer.exe /select` (Windows Explorer via WSL2 wslpath)
- **Logging**: Daily-rotated logs to `<vault>/logs/jasper.log` (no external log aggregation)

## Build & Embed Pipeline

# Outputs: frontend/dist/ (index.html + assets/)

# Copy frontend dist into Go binary source tree

# Go binary embeds via //go:embed all:dist at compile time

# Backend embeds SQL migrations at compile time

# Files: backend/migrations/{001_initial.sql, 002_tags_backlinks.sql, 003_fts.sql, 004_mcp_grants.sql}

## Development Tools

| Tool | Version | Purpose |
|------|---------|---------|
| **go generate** | stdlib | Wires oapi-codegen via `//go:generate` directive in `backend/internal/api/api.go`; outputs `openapi_gen.go` |
| **openapi-typescript** | v7.4.0 | Regenerates `frontend/src/api/schema.d.ts` from `api/openapi.yaml`; wired into `npm run build` |
| **oapi-codegen** | v2.7.0 | Regenerates `backend/internal/api/openapi_gen.go`; wired into `go generate` |
| **golangci-lint** | v1.62+ | Go linting; run via `make lint`; config: `.golangci.yml` |
| **gofumpt** | (tool via go.mod) | Stricter gofmt; included in golangci-lint formatter section |
| **air** | v1.62.0 (tool) | Go hot-reload during dev; config: `.air.toml`; run via `make dev` |
| **concurrently** | 9.0.0 | Frontend package.json script; runs backend (air) + frontend (vite) in parallel for `make dev` |
| **prettier** | (not installed; use eslint formatter) | Not used; eslint handles formatting via flat config |
| **eslint** | 9.0.0 | Frontend linting + formatting; flat config in `frontend/eslint.config.js` |
| **typescript** | 5.9.0 | Frontend: `npm run build` runs `tsc -b` before Vite |
| **Vite** | 8.0.0 | Frontend build; outputs to `frontend/dist/` |
| **Vitest** | 2.1.0 | Frontend unit tests; run via `npm test -- --run` or `npm test` (watch) |
| **Playwright** | 1.59.1 | E2E tests; spins up binary per test; run via `npx playwright test` from `frontend/` |
| **Make** | (system) | Task runner; Makefile at repo root |
| **GitHub Actions** | (CI) | Build + test on macOS, Linux, Windows (Docker-based fake-WSL); kept simple for self-host project |

## Version Compatibility Matrix

| Constraint | Supported | Notes |
|-----------|-----------|-------|
| **Go 1.25.0** | chi/v5 ≥ 5.2.5, modernc.org/sqlite ≥ 1.50, coder/websocket 1.8.14 | All current; no conflicts |
| **Node 22+** | Vite 8.0, npm 10.x, all frontend deps | Vite 8 requires 22.12+ or 20.19+ LTS |
| **React 19.2** | react-arborist 3.5.0 | 3.5.0 supports React 18 and 19 per peerDeps |
| **TypeScript 5.9** | @types/react 19.2, typescript-eslint 8.0 | No TS 7 (unstable beta); stay on 5.x for v1 |
| **Vite 8.0** | @vitejs/plugin-react 6.0, vite 8.x | Rolldown bundler default; v7.3 still receives security fixes |
| **CodeMirror 6** | React integration via useEffect mount (direct); no CM wrapper library | Framework-agnostic; custom integration in `EditorPane.tsx` |
| **openapi-typescript 7** | OpenAPI 3.0 and 3.1 | api/openapi.yaml uses 3.1 (supported) |
| **oapi-codegen v2.7** | chi/v5 v5.2+ | Generates chi-server interfaces; strict-server interface enforces all routes implemented |
| **golangci-lint 1.62+** | Go 1.23+ | Keep config minimal; .golangci.yml specifies enabled linters only |

## Conventions

## Build & Embedding Pipeline

## OpenAPI Contract & Code Generation

- `api/openapi.yaml` — canonical specification (committed)
- `backend/internal/api/openapi_gen.go` — generated (via `go generate`)
- `frontend/src/api/schema.d.ts` — generated (via npm script)
- **Backend:** `make gen-go` runs `cd backend && go generate ./...`, which invokes `//go:generate oapi-codegen --config=cfg.yaml ../../api/openapi.yaml` at the top of `backend/internal/api/gen.go`. Generates `openapi_gen.go` containing the `StrictServerInterface`, request/response types, and chi-server middleware.
- **Frontend:** `make gen-ts` runs `cd frontend && npx openapi-typescript ../api/openapi.yaml -o src/api/schema.d.ts`, producing strict TypeScript types for every route's request/response shape.
- `make gen-check` runs `make gen` then checks for drift: `git diff --exit-code -- backend/internal/api/openapi_gen.go frontend/src/api/schema.d.ts`. Blocks CI (`.github/workflows/...` or lefthook pre-commit) until the developer regenerates and commits both artifacts.
- **When adding a route or changing request/response schemas:** update `api/openapi.yaml` first, run `make gen`, then commit both the spec and the generated code together. The two are locked in sync.

## Error Handling

- `notes.ErrCaseCollision` — case-insensitive path collision (mapped to 409 Conflict)
- `notes.ErrNotFound` — note/folder does not exist (mapped to 404 Not Found)
- `notes.ErrInvalidContent` — validation failure (mapped to 400 Bad Request)
- `fsstore.ErrCycle` — move destination is inside source (mapped to 400)
- `fsstore.ErrCaseCollision` — on-disk name collision (mapped to 409)
- `fsstore.ErrParentNotFound` — target parent folder missing (mapped to 400)
- `fsstore.ErrFolderNotEmpty` — non-recursive delete of non-empty dir (mapped to 409)
- `fsstore.ErrPathEscape`, `ErrAbsolutePath`, `ErrEmptyPath`, `ErrNotInRoot` — path validation failures (mapped to 400)

## Naming Patterns

- **Files:** `foo_handler.go` (API handler), `foo_test.go` (colocated tests), `foo_service.go` (domain logic), `ports.go` (interface definitions)
- **Functions:** PascalCase, unexported helpers start with lowercase (e.g., `mapServiceErrorToWire`)
- **Types:** PascalCase for exported interfaces and structs (e.g., `FileStore`, `StrictServerInterface`)
- **Sentinel errors:** `ErrCaseCollision`, `ErrNotFound`, `ErrCycle` — exported, all-caps with Err prefix
- **Files:** `CamelCase.tsx` (React components, one per file), `camelCase.ts` (utilities), `foo.test.tsx` (colocated tests)
- **Component exports:** Named exports (e.g., `export const MyComponent = () => { ... }`)
- **Hooks:** `useHookName` (e.g., `useFileTree`, `useVaultPicker`)
- **Module exports:** Prefer named exports; barrel files (`index.ts`) export a cohesive group (e.g., `export { useNotes, getNote } from "./notesApi"`)
- **Files:** `phaseN-uat.spec.ts` (UAT scenarios), `phaseN-regression.spec.ts` (specific regressions)
- **Test blocks:** Describe blocks tagged with `@tag` for selective runs (e.g., `@first-run`, `@reveal`, `@deep-link`)

## Code Style & Formatting

- **Formatter:** `gofumpt` (stricter than `gofmt`, enforced via `.golangci.yml`)
- **Linter:** `golangci-lint` with enabled rules: `errcheck`, `govet`, `staticcheck`, `revive` (`.golangci.yml`)
- **Line length:** No hard limit; conventional Go readability norms apply
- **Imports:** Grouped in order: stdlib, third-party, local (enforced by `goimports` if wired)
- **Comments:** Thin and why-not-what — only non-obvious decisions earn a comment; no planning-doc references in code; functional/directive comments exempt. See CONVENTIONS.md § "Comment policy".
- **Formatter:** (not explicitly wired; uses project-local Prettier if present, or none if not)
- **Linter:** ESLint with flat config at `frontend/eslint.config.js`. Enables `typescript-eslint` rules, `react-hooks` plugin, `react-refresh` plugin. Ignores `dist/`, `node_modules/`, and the generated `src/api/schema.d.ts`.
- **Line length:** Conventional (no hard limit; IDE wrap at 80–100 is normal)
- **Imports:** Group by: React/external libraries, local components, utilities, types

## Commit Message Conventions

- `feat(scope): description` — new feature
- `fix(scope): description` — bug fix
- `test(scope): description` — test additions or fixes
- `docs(scope): description` — documentation
- `chore(scope): description` — tooling, deps, cleanup
- `refactor(scope): description` — code reorganization (no behavior change)
- Phase scopes: `feat(phase-08)`, `fix(phase-07)`
- Task scopes: `feat(08-17b)`, `test(08-22)`
- Area scopes: `fix(notes-service)`, `test(tree-dnd)`
- `feat(08-17b): /vault/* OpenAPI routes + handler implementations + tests`
- `test(phase-08): close UAT-2 with hard-accept promotion`
- `docs(08-22): complete tree row + ACL refresh plan`

## Verification Policy: E2E Before Human UAT

## Gap-Closure Plan Pattern: Halt-If-Inconclusive Gate

## Investigation-First for Behavioral Issues

## Ambiguity Resolution: AskUserQuestion Before Drafting

## UAT Acceptance Discipline: Soft-Accept vs Hard-Accept

- Plans that depend on a previous "accepted" item should note `soft-accept (UAT-N, YYYY-MM-DD)` in their `depends_on:` rationale
- Do NOT delete code that was reversed under a soft-accept — orphan it with a dated comment
- Move reversed-decision code to a separate area (e.g., `frontend/src/components/orphaned/`) rather than deleting immediately
- At the next phase's start, confirm if the reversal sticks; only then remove

## Plan-vs-Investigation Consistency

- Either amend the plan file (update `<interfaces>` / `<action>` after investigation, commit before dispatching GREEN)
- Or write an investigation-first plan (skip example code; link to investigation as single source of truth)

## Orphaned Code as Design Signal

## Plan Sizing: Bundle vs Split

- Each task is < 30 min
- The failure surface is localized
- No investigation or design ambiguity
- Anything with investigation required
- Design ambiguity across tasks
- Cross-cutting refactor
- Complex task chains with risk of mid-flight resumption

## Worktree vs In-Main Execution

- ≥3 plans run in parallel AND touch disjoint code surfaces
- The work might destabilize main temporarily (e.g., large refactor)
- Cherry-pick into main
- Run `go clean -cache && golangci-lint cache clean` to avoid stale-path lint errors from the abandoned worktree's source

## Phase Transitions

- Closing on soft-accepts (wait 24–48h for hard-accept first)
- Deleting orphaned code without a decision (defer to next phase if unclear)
- Carrying > 5 pre-existing failures forward (triage before opening next phase)
- Skipping the retro (lessons feed into CONVENTIONS.md)

## Architecture

## System Overview

```text

```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| App | Composition root; chi router setup; handler registration | `backend/internal/app/app.go` |
| Lifecycle | Startup sequence; vault resolution; migrations; incremental reindex | `backend/internal/app/lifecycle.go` |
| VaultSwap | Orderly teardown/reopen of per-vault subsystems during hot-swap | `backend/internal/app/lifecycle_vault_swap.go` |
| Service | Domain logic: Get, Create, Update, Delete, Move; file-FIRST save path | `backend/internal/notes/service.go` |
| FileStore | Atomic write primitives; disk I/O contract | `backend/internal/fsstore/store.go` |
| Index | SQLite-backed metadata index; FTS5 search; incremental reconcile | `backend/internal/index/indexer.go` |
| Indexer Reconcile | Startup delta scan; walk filesystem, sync index | `backend/internal/index/reconcile.go` |
| Migration Runner | Custom runner; 3-path resilience; backup-restore strategy | `backend/internal/db/migrate/runner.go` |
| WebSocket Hub | Multi-client broadcast; origin-filtered events; slow-client drop | `backend/internal/wshub/hub.go` |
| API Server | oapi-codegen strict-server; routes → service calls | `backend/internal/api/api.go` + generated handlers |
| Vault Model | Current vault tracking; hot-swap state machine; app.json persistence | `backend/internal/vault/vault.go` |
| MCP Server | Write-grant ACL; per-folder tool access; port 6684 | `backend/internal/mcp/server.go` |
| Config Loader | Load/save .json; validation; environment override chain | `backend/internal/config/config.go` |
| Markdown Parser | Goldmark + extensions (wikilink, frontmatter, FTS tokenizer) | `backend/internal/markdown/parser.go` |
| SPA Root | App shell; state machines (reindex, vault-switch); global keymap | `frontend/src/App.tsx` |
| Editor Pane | CodeMirror 6 instance; save state machine; conflict resolution | `frontend/src/components/EditorPane.tsx` |
| File Tree | react-arborist virtualized tree; drag-drop; bidirectional H1↔filename | `frontend/src/components/FileTree.tsx` |
| Live Preview | CodeMirror decoration plugin; AST walk; inline heading/emphasis render | `frontend/src/editor/livePreviewPlugin.ts` |
| Session Sync | WebSocket connection; reconnect loop; event dispatch | `frontend/src/lib/useSessionSync.ts` |
| Vault Picker | Folder browser; vault list; create/open/switch flows | `frontend/src/setup/VaultPicker.tsx` |
| Vault Switcher | Hot-swap overlay; failsafe timer; window.location.reload | `frontend/src/lib/useVaultSwitch.ts` |
| Tree Store | Zustand store; expanded folders, active note, pending rename | `frontend/src/lib/useTreeStore.ts` |
| Command Palette | Cmd+P FTS search results; actions dispatcher | `frontend/src/components/CommandMenu.tsx` |

## Pattern Overview

- **Spec-first:** OpenAPI 3.1 (`api/openapi.yaml`) is the single source of truth; Go handler types and TS fetch types are generated from it (`oapi-codegen` v2.7, `openapi-typescript` v7).
- **File-FIRST save path:** Every write goes `fsstore.WriteAtomic` (temp → fsync → rename → fsync parent) BEFORE `Index.Upsert` and BEFORE `wshub.Broadcast`. Filesystem is always recoverable; SQLite is regenerable via reconcile.
- **Derived index resilience:** 3-path migration strategy with backup-first and two explicit recovery pathways. A corrupted SQLite can be wiped and reconstructed from the markdown files on disk without data loss (core PROJECT constraint).
- **Bind posture:** The MCP listener (port 6684) is loopback-enforced at startup via `internal/netbind.RequireLoopbackBind`. The primary HTTP listener (port 6683) defaults to `127.0.0.1` and is LAN-bindable only by explicit opt-in through the `--bind` flag or the `server.bind` config field (NET-01); `csrfOriginMiddleware` guards state-mutating routes on every bind (NET-04), and `jasper doctor` / `jasper status` report and warn when bound beyond loopback (NET-03).
- **WebSocket as cache-invalidation source:** Multi-session sync via `wshub.Broadcast` with origin-session filtering (SYNC-03). No stale-while-revalidate; server truth is pushed to all connected clients (except sender).
- **Bidirectional filename↔H1 binding:** Editing the first heading (H1) renames the file on disk; renaming the file updates the H1 in the content. Implemented via `notes.Rewriter` (walk AST, rewrite frontmatter + first H1).
- **ADR-001 vault model:** App-level `~/.jasper/app.json` (current_vault, recent list) + per-vault `config.json` + `.jasper/` directory inside each vault. Hot-swap orchestrates ordered teardown (DB pair → indexer → MCP → logger) and reopen.

## Layers

- Purpose: Single-user daemon; subcommands for service install/uninstall/status/doctor.
- Location: `backend/cmd/jasper/`
- Contains: cobra root; subcommand implementations; launchd/systemd integration via `kardianos/service`.
- Depends on: `internal/app`, `internal/vault`, `internal/config`, `internal/installer`.
- Used by: User's shell; macOS launchd LaunchAgent; WSL2 systemd user unit.
- Purpose: Wire concrete adapters (FileStore, Index, Hub, Service) into chi router; inject dependencies.
- Location: `internal/app/app.go`
- Contains: App struct; New() constructor; http.Handler setup; middleware chain (logger, recovery, static SPA fallback).
- Depends on: chi, fsstore, index, notes.Service, wshub, api (generated), static.
- Used by: `cmd/jasper/serve.go` (startup), lifecycle.Run (swap handler after migrations).
- Purpose: Execute the 9-step boot sequence; migrations; incremental reindex; vault mode resolution (ADR-001).
- Location: `internal/app/lifecycle.go` + vault-specific helpers (`lifecycle_vault.go`, `lifecycle_vault_swap.go`).
- Contains: Run() method; per-step error handling; disk-full and unrecoverable guards; graceful shutdown; vault-switch coordination.
- Depends on: sqlite, migrate, index, fsstore, notes.Service, vault, wshub, mcp, config.
- Used by: `cmd/jasper/serve.go` (blocking call during startup).
- Purpose: OpenAPI route → StrictServerInterface implementation; request/response marshaling.
- Location: `internal/api/api.go` (hand-written server setup) + `internal/api/*_handler.go` (generated stub implementations + call-through to Service).
- Contains: Server struct; handler constructors; route definitions (POST /notes, PUT /notes/{id}, DELETE /notes/{id}, POST /notes/{id}/move, GET /tree, POST /folders, GET /ws, POST /admin/reindex, GET /admin/status, etc.).
- Depends on: chi, notes.Service, index, wshub, static (SPA fallback), config.
- Used by: chi router mounted under /api/v1.
- Purpose: CRUD operations; registry (UUID → relPath); file-FIRST save contract; backlink/tag extraction.
- Location: `internal/notes/service.go`
- Contains: Get(), Create(), Update(), Delete(), Move(), GetFolders(), ListNotes(); Event emission; Save-conflict detection (If-Match).
- Depends on: FileStore (fsstore), Index (index), Broadcaster (wshub), Registry, markdown parser.
- Used by: API handlers; reconcile loop.
- Purpose: Atomic write primitive; path canonicalization (NFC + lowercase); case-collision detection.
- Location: `internal/fsstore/store.go`
- Contains: AtomicWrite(); path normalization; error classification (ErrCaseCollision maps to 409).
- Depends on: os, filepath, unicode/norm.
- Used by: notes.Service.Update(), notes.Service.Create(); Rewriter (H1↔filename).
- Purpose: Full-text search (FTS5); metadata queries; incremental reconcile.
- Location: `internal/index/indexer.go` + `reconcile.go`
- Contains: Indexer struct; Open(), Close(); Upsert(), Delete(); Reconcile(ModeIncremental); Search(); writer/reader sqlite.Pair with WAL.
- Depends on: modernc.org/sqlite v1.50 (pure-Go, no CGo); FTS5 + JSON1 compiled in.
- Used by: Lifecycle (incremental reindex); notes.Service (Upsert after write); API handlers (search).
- Purpose: Embed SQL migrations in binary; execute with backup-first strategy; recover from failure.
- Location: `internal/db/migrate/runner.go`
- Contains: Runner struct; Run() with three outcomes (StateOK, StateRolledBack, ErrUnrecoverable); Path 1 (apply migrations), Path 2 (rollback + restore backup), Path 3 (hard reset from disk).
- Depends on: migrations.FS (embedded via //go:embed); sqlite Pair.
- Used by: Lifecycle.Run() step 6.
- Purpose: Broadcast cache-invalidation events to all connected clients.
- Location: `internal/wshub/hub.go` + envelope.go + handler.go + client.go
- Contains: Hub struct; Broadcast(eventType, payload, originSessionID); register/unregister/closeSlow.
- Depends on: github.com/coder/websocket; log/slog.
- Used by: API routes (GET /ws upgrade); notes.Service (Broadcast after save).
- Purpose: Current vault tracking; hot-swap orchestration; per-vault config persistence.
- Location: `internal/vault/vault.go`
- Contains: CurrentVault(), SetCurrent(), LoadAppJSON(), SaveAppJSON(); hot-swap coordination.
- Depends on: config, os, atomic operations.
- Used by: Lifecycle (step 0 mode resolution); SwapHandler during hot-swap (step 2 teardown).
- Purpose: Write-grant ACL; per-folder tool access; port 6684.
- Location: `internal/mcp/server.go` + `grants.go`
- Contains: Server struct; Tool handlers (create_note, update_note, move_note, delete_note); tier enforcement.
- Depends on: chi, notes.Service, config (grants from app.json).
- Used by: Lifecycle (step 8, started conditionally if vault-enabled).
- Purpose: Extract tags, wiki-links, first heading; walk AST for rewriting.
- Location: `internal/markdown/parser.go` + extension helpers (tags.go, wikilink.go, etc.)
- Contains: ParseDocument(), Extract*() functions; tag/link enumerators; AST walkers.
- Depends on: github.com/yuin/goldmark; go.abhg.dev/goldmark/wikilink, go.abhg.dev/goldmark/frontmatter.
- Used by: notes.Service (tag extraction, link rewriting); index reconcile (FTS tokenization).
- Purpose: Note editor; file tree; search; settings.
- Location: `frontend/src/`
- Contains: App.tsx (root shell); components (FileTree, EditorPane, CommandMenu, etc.); lib hooks (useSessionSync, useFileTree, useVaultSwitch); setup (VaultPicker).
- Depends on: React 19.2, CodeMirror 6, react-arborist, Radix UI primitives, Zustand, openapi-fetch.
- Used by: Browser; opened at http://127.0.0.1:6683.
- Purpose: Inline rendering of markdown formatting while typing.
- Location: `frontend/src/editor/livePreviewPlugin.ts`
- Contains: ViewPlugin that walks @lezer/markdown AST; Decoration.mark/replace/widget for headings, emphasis, blockquotes, HR, code, frontmatter.
- Depends on: @codemirror/view, @codemirror/state, @lezer/markdown, custom decoration renderer.
- Used by: MarkdownEditor.tsx (mounted on editor creation).
- Purpose: Connect to backend WebSocket; reconnect loop; event dispatch to handlers.
- Location: `frontend/src/lib/useSessionSync.ts`
- Contains: useSessionSync() hook; exponential backoff; origin-session filtering; inbound event routing.
- Depends on: WebSocket API, backoff.ts, other hooks (useTreeStore, useFileTree, etc.).
- Used by: App.tsx (mounted at root).

## Data Flow

### Primary Request Path: Note Update (SYNC-06 optimistic locking)

### File-Tree Synchronization (TREE-01 + hot-swap)

### Full-Text Search (Phase 7 Cmd+P Palette)

### Incremental Reindex (Startup + Manual via Admin)

### Vault Hot-Swap (ADR-001, Phase 8)

## Key Abstractions

- Purpose: Represents a single markdown file with metadata.
- Examples: `internal/notes/note.go` defines the Note struct; frontend also has matching types from openapi-typescript.
- Pattern: Struct with id (UUID), path (relative), title, content, updated_at, tags, h1 (extracted), created_at.
- Purpose: Hierarchical file-tree projection for UI rendering.
- Examples: Returned by GET /api/v1/tree; shaped as {kind: "note"|"folder", id, path, title, children: TreeNode[]} for folders.
- Pattern: Recursive structure; virtualized by react-arborist.
- Purpose: WebSocket message wrapper; schema-versioned.
- Examples: {event: "note.updated", payload: {...}, origin_session_id: "..."}.
- Pattern: Defined in OpenAPI schema; all inbound/outbound WS messages conform to this schema (TYPE-01).
- Purpose: Abstract contract for cache-invalidation; allows tests to mock.
- Examples: `internal/notes/ports.go` defines interface; `internal/wshub/hub.go` implements; `internal/notes/service_test.go` uses mock.
- Pattern: Interface-driven; nopBroadcaster substitutes when nil.
- Purpose: Abstract contract for disk I/O; allows tests to use in-memory substitute.
- Examples: `internal/notes/ports.go` defines interface; `internal/fsstore/store.go` implements; tests use fstest.MapFS.
- Pattern: Interface-driven; composition root injects concrete.
- Purpose: Abstract contract for metadata queries and search; allows non-SQLite implementations (though Jasper locked to SQLite).
- Examples: `internal/notes/ports.go` defines interface; `internal/index/indexer.go` implements; nopIndex substitutes in Phase 1 tests.
- Pattern: Interface-driven; composition wires real or mock.

## Entry Points

- Location: `backend/cmd/jasper/main.go`
- Triggers: User runs `jasper serve` (default), `jasper install`, `jasper uninstall`, `jasper status`, `jasper doctor`, `jasper version`.
- Responsibilities: Parse cobra flags; dispatch to subcommand handler; exit with status code.
- Location: `backend/cmd/jasper/serve.go:runServe() → app.New() → lifecycle.Run()`.
- Triggers: "serve" subcommand executed.
- Responsibilities: Resolve data-dir (flag → env → default); call app.New(); call lifecycle.Run(); block until ctx.Done or fatal error.
- Location: `backend/internal/api/ws.go:HandleWS()` or GET /api/v1/ws handler.
- Triggers: Browser initiates WebSocket handshake with query param `session_id`.
- Responsibilities: Chi router routes to handler; handler calls wshub.HandleUpgrade(w, r); hub registers client; client pumps inbound/outbound messages.
- Location: `frontend/src/main.tsx` → React.createRoot(document.getElementById('root')).render(<App />).
- Triggers: Page load at http://127.0.0.1:6683.
- Responsibilities: Mount React tree; load cached state from localStorage; call useSessionSync (WebSocket connect); call useFileTree (initial tree fetch); render UI.
- Location: `frontend/src/setup/VaultPicker.tsx` or `frontend/src/setup/SetupApp.tsx`.
- Triggers: App.tsx detects no currentVault set (ADR-001 Step 3).
- Responsibilities: Mount picker UI at / (SPA root); list recent vaults; offer "Create new" and "Open existing"; on selection, POST /api/v1/vault/open {path} → server updates app.json → page reloads to main app.

## Architectural Constraints

- **Threading:** JavaScript is single-threaded event loop (browser); Go uses goroutines (backend). Migration runner and indexer reconcile both run in background goroutines without blocking the HTTP listener. WS hub reads are RWMutex-guarded; broadcasts do not hold Lock (Pitfall 6).
- **Global state:** App.Handler is swappable (AtomicValue, app_test.go line ~350) — allows lifecycle.Run to replace the router after migrations complete without dropping in-flight requests. TreeStore is Zustand (single source, Pub/Sub); SessionSync is the WS connection (singleton per tab). No shared mutable state across components except the Zustand stores.
- **Circular imports:** None known. Internal packages respect layering: api calls service, service calls ports (fsstore/index), ports do not call up. Frontend components import lib hooks and API clients; hooks import other hooks via dependency injection.
- **Filesystem as source of truth:** SQLite is always regenerable from notes/. Migrations employ backup-first + three explicit recovery paths (Path 1: apply, Path 2: rollback + restore, Path 3: wipe + reconcile). This contract is non-negotiable per PROJECT §Data Integrity.
- **Bind posture:** `netbind.RequireLoopbackBind` enforces 127.0.0.1 for the MCP listener only. The HTTP listener defaults to 127.0.0.1 and accepts a non-loopback bind via `--bind` or `server.bind` (NET-01) — a deliberate, documented opt-in, not an override.
- **WebSocket session isolation:** Each browser tab gets a unique session_id (generateOrLoadSessionId via sessionId.ts); server broadcasts exclude the origin tab (origin_session_id filter, SYNC-03).
- **Bidirectional H1↔filename binding:** Editing H1 triggers Rewriter (notes.Service); renaming file triggers H1 rewrite in update. Both flows synchronize via the Service's internal contract. Not bidirectional across the API — only one API call initiated per user action; the other side is derived.

## Anti-Patterns

### Direct SQLite Queries Outside Index Package

### Writing SQLite Without Filesystem First

### Unfiltered WebSocket Broadcasts

### Frontend State Out of Sync with Backend

### Migration Runner Assuming No Concurrent Writes

### Ignoring fs.FS Abstraction in Tests

### Losing Origin Session ID on WS Reconnect

## Error Handling

- **400 Bad Request:** Malformed request body, invalid title chars, parent traversal attempt (input validation). Client retries with corrected input.
- **409 Conflict:** Case-insensitive collision (ErrCaseCollision), stale write (If-Match mismatch), concurrent rename conflict. Client surfaces a disambiguating dialog (SaveConflictBanner, RenameRewriteErrorBanner).
- **404 Not Found:** Unknown note UUID, missing vault path, deleted during operation. Client resets active state and refetches tree.
- **500 Internal Server Error:** Atomic write failed, index transaction failed, WS marshal failed, disk full. Client mounts a retry banner (MigrationBanner, ResetAndRebuildDialog).
- **503 Service Unavailable:** Server is paused (during vault hot-swap). Client mounts VaultSwitchOverlay and waits for "vault.switched" broadcast.

## Cross-Cutting Concerns

- **Development:** stderr (stdout from go run / air).
- **Service:** Per-vault rotating log file (`<vault>/.jasper/logs/jasper.log`; rotated daily by `internal/log` package).
- **Request:** OpenAPI schema validation (generated by oapi-codegen); missing fields return 400.
- **Business logic:** notes.Service validates parent-path resolution, title canonicalization (NFC + lowercase), case-collision detection. Errors mapped to appropriate HTTP status.
- **Filesystem:** fsstore.AtomicWrite validates path is within notes/ and does not traverse (`../../../../etc/passwd` is rejected).
- **Writes:** Single-threaded on filesystem (atomic rename is atomic; no concurrent renames of the same file). SQLite writer mutex ensures only one write transaction at a time. Service.Update() serializes conflicting writes (If-Match guards).
- **Reads:** Multiple concurrent readers (sqlite reader conn, WebSocket clients). Index.ListNotes() acquires RLock; wshub.Broadcast acquires RLock. No Lock held across I/O.

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature-slug>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

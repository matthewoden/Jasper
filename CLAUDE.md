<!-- GSD:project-start source:PROJECT.md -->
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
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Backend Core (Go)
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Go** | **1.23 or 1.24** (1.22+ minimum) | Backend language | Single static binary, strong file I/O + SQLite story, Go 1.22 added pattern-based routing to `net/http` that obviates a lot of router need. 1.23/1.24 are the actively-supported releases. **HIGH** |
| **`github.com/go-chi/chi/v5`** | **v5.2.5** (Feb 2025) | HTTP router | Composable middleware chains, route grouping (`r.Route("/api/v1", ...)`), `chi/middleware` package (Logger, Recoverer, RealIP, Compress, Timeout, RequestID) saves writing them. Internally uses Go 1.22's tree-based mux. ~Zero deps. Best fit for the ~20-route API in DESIGN.md §5.1. **HIGH** |
| **`modernc.org/sqlite`** | **v1.50.x** (latest as of Apr 2026; track latest) | SQLite driver | Pure-Go transpiled port of SQLite — no CGo, single static binary on every target. Compiled with FTS5, JSON1, RTree extensions enabled — exactly what `DESIGN.md §9` needs for FTS search. Locked by PROJECT constraint. **HIGH** |
| **`github.com/coder/websocket`** | **v1.8.14** (Sep 2024) | WebSocket | The official continuation of `nhooyr.io/websocket` — that import path is **deprecated** as of Aug 2024 (Coder org adopted maintenance). Tiny, idiomatic, context-first, zero deps, works directly with `net/http` upgrade. Significantly simpler API than gorilla. **HIGH** |
| **`github.com/oapi-codegen/oapi-codegen/v2`** | **v2.7.0** (May 2025) | OpenAPI → Go server stubs | Locked by PROJECT key decision. Generates `chi-server` + `strict-server` interfaces — handlers implement a typed interface, compiler enforces all routes are covered. v2.2.0+ supports a pure Go 1.22+ `net/http` server target as well, but `chi-server` matches our router choice. **HIGH** |
| **`github.com/yuin/goldmark`** | **v1.8.2** (Mar 2025) | Markdown parser (server-side) | Server-side parser for backlink + tag extraction. CommonMark-compliant, AST is walkable, extensible. Used by Hugo and many others; the canonical Go markdown parser. **HIGH** |
| **`go.abhg.dev/goldmark/frontmatter`** | latest (active) | YAML/TOML frontmatter | Goldmark extension that parses the `---` block at file head. Direct fit for `DESIGN.md §7` (tags in YAML frontmatter). Returns the parsed map; the renderer skips it. **HIGH** |
| **`go.abhg.dev/goldmark/wikilink`** | latest (active) | `[[wiki-link]]` parsing | Goldmark extension for `[[Title]]` and `[[Title\|Alias]]`. Provides a custom `Resolver` interface — exactly the hook needed for the same-folder-then-alphabetical resolution rule from PROJECT key decisions. **HIGH** |
| **`github.com/golang-migrate/migrate/v4`** | **v4.19.1** (Nov 2025) | Migration runner | With `source/iofs` driver, embeds `migrations/*.sql` via `go:embed` directly into the Go binary — exactly what DESIGN.md §4.2 specifies. Deterministic version table (`schema_migrations`), well-supported, mature. **HIGH** |
| **`github.com/kardianos/service`** | **v1.2.x** (active; commits through 2025) | OS-service installer | Cross-platform service registration: macOS launchd plists, systemd units, Windows services, SysV/Upstart/OpenRC. Single API across platforms. Lets us ship `jasper install` / `jasper uninstall` / `jasper start` / `jasper stop` subcommands without per-OS code paths. **MEDIUM-HIGH** (fork `k0sproject/kardianos-service` exists with more frequent releases; default to upstream). |
### Frontend Core (Web)
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **TypeScript** | **5.9.x** (5.8 LTS-ish acceptable) | Frontend language | TS 5.8 GA Feb 2025; 5.9 is the current `latest` on npm. Avoid the not-yet-released TS 7 (Strada/Corsa transition; first beta). Stick to 5.x for stability through v1. **HIGH** |
| **React** | **19.2.x** | UI framework | React 19 stable since Dec 2024; 19.2 (Oct 2025) is current minor. Concurrent features, Actions, ref-as-prop are all stable. Single-user app — no SSR needed; CSR/SPA only. **HIGH** |
| **Vite** | **8.0.x** (or 7.3 LTS-ish) | Build tool / dev server | Vite 8 GA in Dec 2025 ships Rolldown (Rust bundler) by default — much faster builds. Vite 7.3 still receives security/important fixes if you want a longer-baked tree. Either is correct; new project → 8. Vite outputs static `dist/` that the Go binary embeds via `go:embed`. **HIGH** |
| **`@vitejs/plugin-react`** | latest (matches Vite 8) | React Fast Refresh | Standard plugin; nothing to think about. **HIGH** |
| **CodeMirror 6** (`codemirror` meta-package or à-la-carte `@codemirror/*`) | meta v6.0.x; modules tracked individually | Markdown editor | Locked by PROJECT decision. The editor that Obsidian itself uses for Live Preview. Decoration API (`Decoration.mark`, `Decoration.replace`, `Decoration.widget`, `MatchDecorator`, `ViewPlugin`) is the right primitive for "render headings/bold/italic/blockquotes inline as you type." Modular — pull only the packages you use. **HIGH** |
| **`@codemirror/lang-markdown`** | **v6.5.0** | Markdown grammar/parser for CM6 | GFM + emoji + smart Enter (continues lists/blockquotes), Backspace deletes markup. Provides the syntax-tree foundation our decoration plugin walks for live rendering. **HIGH** |
| **`@codemirror/state`** | v6.x | Editor state primitives | Required for any custom CM6 extension. **HIGH** |
| **`@codemirror/view`** | v6.x | DOM/decoration layer | Where `ViewPlugin`, `Decoration`, `WidgetType`, `MatchDecorator` live. Core of the live-render extension. **HIGH** |
| **`@codemirror/commands`** | v6.x | Standard keymaps | History, default keys. **HIGH** |
| **`@codemirror/search`** | v6.x | Find/replace within editor | Optional but cheap. **MEDIUM** |
| **`@lezer/markdown`** | latest | Underlying parser used by lang-markdown | Walked by decoration plugin to know "this range is a heading," "this range is bold," etc. **HIGH** |
| **`react-arborist`** | **v3.5.0** (Apr 2026) | File-tree sidebar | Virtualized (handles 1000+ nodes — DESIGN.md §13 NFR), built-in drag-and-drop with the kind of indent/drop-line UX a file tree needs, inline rename, keyboard nav, multi-select. The "VS Code sidebar" component for React. Actively maintained (3.5.0 only weeks old). Saves writing a custom tree (~weeks). **HIGH** |
| **`openapi-typescript`** | **v7.x** (latest, Feb 2026) | Generates TS types from OpenAPI | Reads `api/openapi.yaml` at build time, emits a single `paths.d.ts` of the entire API surface. Zero runtime cost. **HIGH** |
| **`openapi-fetch`** | **v0.17.0** (Feb 2026) | Typed fetch client | ~6kB; thin typed wrapper over native `fetch`. `client.GET("/notes/{id}", { params: { path: { id }}})` with full inference of body / response / errors. Pairs natively with the types `openapi-typescript` emits. No hand-written client code. **HIGH** |
### Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `github.com/google/uuid` | latest v1.x | UUID generation for note IDs | Per `DESIGN.md §4.3` — UUIDs for note PKs to survive renames. Stdlib has no UUIDs. **HIGH** |
| `github.com/rs/zerolog` *or* `log/slog` (stdlib) | — | Structured logging | Prefer **`log/slog`** (stdlib, since Go 1.21) — zero-dep, structured, perfectly adequate for a single-user app. Use `samber/slog-chi` if you want chi-aware HTTP request logging out of the box. **HIGH** |
| `github.com/spf13/cobra` | v1.x | CLI subcommands (`jasper install`, `start`, `stop`, etc.) | The native-install story needs a CLI surface around the server binary; cobra is the canonical choice and integrates cleanly with `kardianos/service`. **MEDIUM-HIGH** |
| `github.com/spf13/viper` *or* stdlib `encoding/json` | — | Config loading | For a *single* JSON config file (`config.json`), **stdlib `encoding/json` is sufficient** — viper is overkill. Add only if env-var overrides become necessary. **HIGH** |
| `github.com/fsnotify/fsnotify` | v1.x | Optional config-file watcher | DESIGN.md §11 mentions "reload config without restart." Tiny dep, cross-platform. **MEDIUM** |
| `react-hotkeys-hook` *or* CodeMirror keymaps | — | Global keyboard shortcuts | Most editor shortcuts go through CM6's keymap; only top-level shortcuts (Cmd-K palette, etc.) need a hook. **MEDIUM** |
| `zustand` | v5.x | Lightweight client state | Tabs/sidebar/active-note state. Avoid Redux — overkill. Avoid TanStack Query for this app — WebSocket is the cache invalidation mechanism, not stale-while-revalidate. Zustand stores + manual invalidation on WS events is the cleanest fit. **MEDIUM-HIGH** |
| `@radix-ui/react-*` (primitives) | latest | Accessible headless UI | Per DESIGN.md §12 "Headless (Radix, shadcn) preferred; avoid heavy opinionated UI kits." Use individual primitives (Dialog, ContextMenu, DropdownMenu, Tooltip) — NOT a full kit. **HIGH** |
| `tailwindcss` | v4.x | Styling | Optional; if used, Tailwind 4 + Vite plugin. Could also do CSS Modules. Implementer's call — do not pull in a heavy theme library. **MEDIUM** |
| `js-yaml` | v4.x | Frontmatter parsing on the *frontend* | Only needed if the editor renders the frontmatter as a tag-chip UI (DESIGN.md §7); otherwise unused. **LOW** (defer; backend already parses frontmatter authoritatively). |
| `date-fns` | v3+ | Date formatting for daily notes | Tiny, tree-shakeable. Avoid Moment. **MEDIUM** |
| `vitest` | v2.x | Frontend tests | Vite-native; replaces Jest. **HIGH** |
| `@testing-library/react` | latest | Component tests | Standard. **HIGH** |
| `@playwright/test` | latest | E2E tests | Optional for v1; the install story (launchd/systemd) cries out for at least one smoke E2E. **MEDIUM** |
### Development Tools
| Tool | Purpose | Notes |
|------|---------|-------|
| `oapi-codegen` (v2.7.0) | Backend codegen | Run via `go:generate` directive at top of `internal/api/api.go`: `//go:generate oapi-codegen --config=cfg.yaml ../../api/openapi.yaml`. Config selects `chi-server,strict-server,types`. |
| `openapi-typescript` (v7) | Frontend codegen | Add an `npm run gen:api` script: `openapi-typescript ../api/openapi.yaml -o src/api/schema.d.ts`. Wire it into `prebuild` and into a watch in dev. |
| `golangci-lint` | Go linting | v1.62+; keep config minimal, enable `errcheck`, `govet`, `staticcheck`, `revive`. |
| `gofumpt` | Stricter `gofmt` | Editor-on-save; zero config. |
| `prettier` + `eslint` (flat config) + `typescript-eslint` | Frontend formatting/linting | Standard 2026 setup. |
| `air` *or* `wgo` | Go hot-reload during dev | Dev quality-of-life only; not in production. |
| `make` *or* `just` | Task runner | Wire `make gen` to run both codegens, `make dev` to start backend + Vite, `make build` for the production binary. |
| GitHub Actions | CI | Build + test on macOS, Linux, Windows. Keep it simple; this is a self-host project, not a SaaS. |
## Installation
### Backend (`backend/go.mod`)
### Frontend (`frontend/package.json`)
# Scaffold
# Pin
# Editor
# Tree
# API
# UI primitives + state + utils
# Dev tooling
## Native Install Tooling (macOS launchd + WSL2 systemd)
### macOS — launchd LaunchAgent (per-user, no sudo)
- Plist lives at `~/Library/LaunchAgents/com.jasper.server.plist`.
- This is the **LaunchAgent** path (not LaunchDaemon) — no admin privileges, runs at login as the user.
- Key plist fields:
- Loaded with `launchctl bootstrap gui/$(id -u) <plist>`; unload with `launchctl bootout`. (`launchctl load/unload` is the legacy form — bootstrap/bootout is the modern equivalent on macOS 10.10+.)
- `kardianos/service` generates this plist for you and exposes `service.Install()` / `service.Uninstall()` / `service.Start()` / `service.Stop()` — wire each to a `jasper install` subcommand.
### WSL2 — systemd user unit
- WSL2 systemd support is opt-in via `/etc/wsl.conf` → `[boot]\nsystemd=true`. **Document this prereq prominently in install docs** — coworkers will hit it.
- Unit at `~/.config/systemd/user/jasper.service`:
- Enable lingering (`loginctl enable-linger $USER`) so the service runs even when no shell is open.
- `systemctl --user enable --now jasper.service`
- `kardianos/service` generates this unit too — same install command path as macOS.
### What `kardianos/service` does NOT do
- It does not handle the `loginctl enable-linger` step on systemd, nor the `wsl.conf` step. Both must be in install docs / a `jasper doctor` subcommand.
- It does not handle a "first-run config wizard" — that's app-level.
## Markdown Editor Approach (CodeMirror 6 live render)
- HyperMD (CM5; conceptual reference for the pattern)
- Obsidian's open Live Preview write-ups (forum posts, blog post)
- `obsidian-codemirror-options` plugin source (CM6-era, demonstrates the decoration patterns)
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `chi/v5` | stdlib `net/http` (Go 1.22+ ServeMux) | If you want zero non-stdlib router deps and are willing to write your own middleware chaining. Perfectly viable. We pick chi for the middleware ergonomics and route grouping at our route count. |
| `coder/websocket` | `gorilla/websocket` | Gorilla is fine and very widely used; coder's API is more idiomatic and modern. Gorilla wins if you specifically need its compression/extension hooks. |
| `coder/websocket` | `nhooyr.io/websocket` | **Avoid** — that import path is deprecated since Aug 2024. Coder fork is the official continuation. |
| `react-arborist` | Custom tree | If react-arborist's drag-and-drop UX doesn't match the desired feel exactly. But react-arborist's DnD is well-tuned for file trees specifically. |
| `react-arborist` | `@dnd-kit/*` + custom virtualization | Lower-level building blocks; more work. Use only if react-arborist becomes a constraint. |
| `react-arborist` | `react-complex-tree` | Stronger a11y story; weaker DX/styling. Acceptable alternative if a11y becomes a sharp requirement. |
| `oapi-codegen` | `ogen` | Stricter, generates more code, steeper learning curve. PROJECT decision picked oapi-codegen for its simplicity. |
| `openapi-fetch` + `openapi-typescript` | `@hey-api/openapi-ts` | hey-api generates a fuller SDK (services, models). Heavier than openapi-fetch's "just a typed fetch wrapper." Choose openapi-fetch for minimum runtime cost. |
| Custom migration runner | `golang-migrate` (with non-CGo SQLite driver) | If you want a battle-tested runner and don't mind the CGo question for migrations specifically. Both are listed in DESIGN.md §2 as acceptable. Custom is recommended here because the three-path resilience strategy (§4.4) is easier to implement when you own the runner. |
| Custom migration runner | `pressly/goose` | Goose has a slightly nicer embed story than golang-migrate. Acceptable if you want a third-party runner without CGo confusion. |
| `kardianos/service` | Hand-written launchd plist + systemd unit templates | More transparent; no library dependency. Acceptable trade-off for ~150 lines of OS-specific code. We default to kardianos for the cross-platform install symmetry. |
| CodeMirror 6 | ProseMirror (e.g. via Milkdown / TipTap) | True WYSIWYG (model is the rendered tree, not text). Heavier; less "markdown-first" — converts to/from markdown. Use only if "edit raw markdown" is rejected as a model. PROJECT explicitly recommends CM6. |
| CodeMirror 6 | Lexical (Meta) | Newer; smaller ecosystem; not markdown-native. Strong React story. Skip for v1 — CM6 has more "markdown editor" prior art. |
| CodeMirror 6 | Monaco | Designed for code editing; heavier; weaker for prose; weak markdown decoration story. **Avoid** for a notes app. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **`mattn/go-sqlite3`** | Requires CGo + a C toolchain in any build environment, breaks the "single static binary on every target" promise, complicates cross-compilation badly. PROJECT explicitly excludes this. | `modernc.org/sqlite` |
| **`nhooyr.io/websocket`** | Deprecated import path since Aug 2024 — repo handed off to Coder org. New code shipping under that path is just confusing. | `github.com/coder/websocket` |
| **Monaco Editor** | Optimized for code; heavyweight (multi-MB); weak markdown live-render story; designed around discrete editor instances, not prose. Heavy bundle hit. | CodeMirror 6 |
| **react-beautiful-dnd** | Officially deprecated by Atlassian. No React 18+/19 support guarantee. | `react-arborist` (built-in DnD) or `@dnd-kit/*` |
| **react-dnd** | React 19 support is iffy; older API; worse DX than dnd-kit. | `react-arborist` (which uses its own DnD layer) |
| **TipTap / Lexical / Slate / ProseMirror-based WYSIWYG (Milkdown, etc.)** | They model the doc, not the markdown text — you constantly serialize/deserialize and risk drift. The PROJECT spec says "edit raw markdown" — using a true-WYSIWYG model fights that. They also bring a *plugin/extension* runtime which is the opposite of Jasper's no-plugin posture. | CodeMirror 6 with custom decoration plugin |
| **Editor frameworks that load remote/community plugins at runtime** (Obsidian-style plugin runtime, any sandboxed JS execution surface) | Directly violates the founding security constraint of Jasper. The whole reason this product exists. | No editor extension runtime — all UI behavior is shipped in the static frontend bundle |
| **Server-side note rendering to HTML for the editor** | The editor is the renderer. Server only renders for export (out of scope v1) and for parsing backlinks/tags. | Goldmark on the server *only* for parsing (AST walking), CM6 on the client for rendering |
| **`gorilla/mux`** | Larger router with regex routes; obviated by Go 1.22 mux + chi. The Gorilla project went into maintenance mode in 2022 (then revived, but momentum is gone). | `chi/v5` or stdlib `net/http` |
| **`gorm`** for SQLite | Heavyweight ORM, complicates the FTS5 + raw-SQL story, hides the schema. We control SQL ourselves. | `database/sql` + maybe `sqlc` (typed query gen) |
| **Docker as the install path for v1** | PROJECT pivoted explicitly to native install. Docker may live as a *secondary* artifact later, but the v1 install story is launchd + systemd. | `kardianos/service` + `jasper install` subcommand |
| **`webpack`, `parcel`, `create-react-app`** | CRA is dead (officially deprecated). Webpack/Parcel are slower than Vite for SPAs. | Vite 8 |
| **Heavy UI kits (MUI, Chakra, Mantine, Ant Design)** | DESIGN.md §12 explicitly says "avoid heavy opinionated UI kits." Bundle bloat. | Radix primitives + your own CSS / Tailwind |
| **Redux / Redux Toolkit** | Overkill for a single-user single-page app where WebSocket is the cache invalidator. | Zustand |
| **TanStack Query as the primary data layer** | Designed for stale-while-revalidate over HTTP; conflicts with WebSocket-as-truth-source model in DESIGN.md §6.1. Adds complexity. | Direct `openapi-fetch` calls + Zustand store + WS event handlers |
| **Moment.js** | Frozen / legacy; huge. | `date-fns` |
| **CodeMirror 5** | Superseded; CM6 has fundamentally better extension model and a real React story. | CodeMirror 6 |
## Stack Patterns by Variant
- Out of v1 scope per PROJECT, but `kardianos/service` *does* support Windows services natively, so the runtime path is there. The only gap is "how do they run a Go binary on Windows" — same `jasper.exe install` story.
- Move from query-time content tokenization to a dedicated FTS5 virtual table populated on save. `modernc.org/sqlite` ships FTS5 compiled in.
- Drop down to `@dnd-kit/core` + `@dnd-kit/sortable` + your own virtualization (e.g. `@tanstack/react-virtual`). More work but full control.
- Phase 2 fallback: render markdown source with **only** mark decorations (bold/italic/code) and line-level styling for headings/blockquotes — skip the "hide syntax markers" effect for v1. Still feels much better than plain monospace; lower risk.
- Switch to `pressly/goose` (best embed story among 3rd-party runners); the three-path strategy is library-agnostic — restore-from-backup happens in your wrapper, not the runner.
## Version Compatibility
| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| Go 1.23 / 1.24 | `chi/v5` ≥ v5.2.5 | chi v5.2.5 sets minimum Go to 1.22. |
| Go 1.23 / 1.24 | `modernc.org/sqlite` ≥ v1.50 | Both stay current; check release notes when bumping Go. |
| Go 1.23 / 1.24 | `coder/websocket` v1.8.14 | Tested through Go 1.24. |
| `oapi-codegen/v2` v2.7 | `chi/v5` v5.2 | Generated `chi-server` interface targets the standard chi router signature. |
| `react@19.2` | `react-arborist@3.5` | 3.5 supports React 18 and 19 (per recent releases). Verify when installing. |
| `vite@8` | Node 22+ | Vite 8 requires Node 22.12+ (or 20.19+ on the LTS line). |
| `openapi-typescript@7` | OpenAPI 3.0 *and* 3.1 | Per `DESIGN.md §3` we use OpenAPI 3.1 — supported. |
| `golang-migrate/migrate/v4` `database/sqlite3` driver | **CGo required** | This is the gotcha — if using golang-migrate, prefer the community pure-Go SQLite source, or use a custom runner. Verified pitfall. |
| CodeMirror 6 | React 19 via `@uiw/react-codemirror` *or* direct integration | The library is framework-agnostic; React wrapper exists but is optional. Direct integration via a small `useEffect`-based mount is cleaner for our deeply-customized editor. |
## Sources
### Context7 (HIGH confidence — authoritative library docs)
- `/codemirror/view` — Decoration API, ViewPlugin, MatchDecorator, WidgetType (verified the live-render pattern is supported)
- `/oapi-codegen/oapi-codegen` and `/oapi-codegen/oapi-codegen-exp` — codegen flags + chi-server target
- `/openapi-ts/openapi-typescript` — generation patterns
- `/go-chi/docs` — middleware + routing
- `/coder/websocket` — confirmed as Coder-maintained continuation; idiomatic API
- `/golang-migrate/migrate` — iofs source driver, embedded SQL
- `/jameskerr/react-arborist` — virtualization, DnD, inline rename — 152 snippets
- `/yuin/goldmark` — parser API
- `/modernc-org/sqlite` and `/gitlab_cznic/sqlite` — pure-Go driver, vtable API
- `/vitejs/vite` — versions v7.x and v8.x indexed
- `/microsoft/typescript` — versions through 5.9 indexed
### Official Docs (HIGH confidence)
- https://github.com/oapi-codegen/oapi-codegen/releases — v2.7.0 confirmed (May 2025)
- https://github.com/coder/websocket/releases — v1.8.14 confirmed (Sep 2024)
- https://github.com/golang-migrate/migrate/releases — v4.19.1 confirmed (Nov 2025)
- https://github.com/go-chi/chi/releases — v5.2.5 confirmed (Feb 2025)
- https://github.com/yuin/goldmark/releases — v1.8.2 confirmed (Mar 2025)
- https://vite.dev/releases — Vite 8.0.10 confirmed as current stable
- https://react.dev/blog/2025/10/01/react-19-2 — React 19.2 stable
- https://www.npmjs.com/package/openapi-fetch — v0.17.0 confirmed (Feb 2026)
- https://www.npmjs.com/package/@codemirror/lang-markdown — v6.5.0 confirmed
- https://learn.microsoft.com/en-us/windows/wsl/systemd — WSL2 systemd opt-in
- https://www.launchd.info/ + Apple's LaunchAgents docs — plist structure, RunAtLoad/KeepAlive semantics
- https://coder.com/blog/websocket — confirms nhooyr → coder transfer, August 2024
- https://github.com/yuin/goldmark + https://pkg.go.dev/go.abhg.dev/goldmark/wikilink + https://pkg.go.dev/go.abhg.dev/goldmark/frontmatter — extension APIs
### MEDIUM confidence
- `kardianos/service` — actively used (1,431 importers per pkg.go.dev) but no recent tagged GitHub releases; commits continue. Acceptable risk for the install layer; falls back trivially to hand-written plist/unit templates if abandoned.
- React-arborist React 19 support — recent v3.5.0 release (Apr 2026) plus 152 snippets in Context7 imply active alignment, but verify peerDeps at install time.
- TypeScript 7 (Strada/Corsa rewrite) — beta-only as of Apr 2026; **stay on TS 5.x for v1**, do not chase TS 7 until well after its GA.
### LOW confidence (call out before relying)
- Exact "best" decoration strategy for "hide syntax markers when cursor is not on the line" — this is implementer territory; reference implementations (HyperMD, Obsidian Live Preview) exist but are different codebases. Budget exploration time.
- Whether the kardianos/service plist defaults are exactly what we want for `KeepAlive` semantics on macOS user agents — verify by hand-inspecting the generated plist before shipping the install command to coworkers.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->

# Jasper — Domain Context

The vocabulary and the invariants. When your output names a domain concept — an issue title, a test name, a refactor proposal, a hypothesis — use the term as defined here.

Decisions and their rationale live in [`docs/adr/`](./docs/adr/). Process rules (how we build, test, and verify) live in [`CONVENTIONS.md`](./CONVENTIONS.md). This file is *what the words mean* and *what must always be true*.

---

## What Jasper is

A lightweight, self-hosted, browser-based markdown notes application — Obsidian-inspired, without the plugin surface. A single Go binary serves a React SPA on the user's own machine and stores notes as plain `.md` files on disk.

**Core value:** writing, searching, and organizing markdown notes in the browser feels as fluid and trustworthy as a native note-taking app — with zero plugin attack surface and full local ownership of the underlying files.

---

## The invariants

These are not preferences. Code that violates one of them is wrong, regardless of whether tests pass.

1. **The filesystem is the source of truth. SQLite is derived and disposable.**
   Wiping the index is never data loss — reconcile rebuilds it from the `.md` files. Every resilience mechanism in the system depends on this staying true. See [ADR-0001](./docs/adr/0001-filesystem-is-the-source-of-truth.md).

2. **Writes go file-first: write the file, then upsert the index, then broadcast.**
   Never the other order. Never truncate before confirming the write succeeded. See [ADR-0007](./docs/adr/0007-file-first-save-path.md).

3. **All writes are atomic** — temp file → fsync → rename → fsync parent. A crash mid-write leaves either the old file or the new one, never a partial.

4. **There is no plugin, extension, or scripting surface. Ever.**
   This is the reason the project exists, not a v1 simplification. See [ADR-0002](./docs/adr/0002-no-plugin-surface.md).

5. **The MCP listener is loopback-enforced regardless of any other configuration.**
   Guarded by a named regression test (`TestMCPAlwaysLoopback`), not by a comment. See [ADR-0013](./docs/adr/0013-mcp-always-on-grant-gated.md).

6. **`api/openapi.yaml` is the contract.** Go handler types and TypeScript fetch types are both generated from it. Changing the API means editing the spec first and committing both generated artifacts. See [ADR-0006](./docs/adr/0006-openapi-as-the-bilateral-contract.md).

7. **One vault is open at a time.** Per-vault state (index, config, logs, grants, UI stores) lives inside that vault and is torn down and reopened on switch. See [ADR-0008](./docs/adr/0008-vault-model.md).

8. **The SPA fallback is mounted last.** In `app.go`, `r.Mount("/", static.Handler())` is a catch-all. Anything mounted after it is unreachable — the fallback answers 200 with `index.html` instead of 404ing, so the failure looks like "it opened the app" rather than an error. Every new route tree mounts before it, with a route-order regression test.

9. **A component mounting is never, by itself, a reason for a network request.** All GETs go through the resource layer, which coalesces unconditionally. See [ADR-0022](./docs/adr/0022-shared-api-resource-layer.md).

---

## Glossary

### Storage and identity

**Vault** — a folder the user opens, containing `notes/` and a `.jasper/` directory. The unit of "a Jasper workspace." One vault is open at a time; switching is a *hot-swap*. This is the user-facing noun — never say "data directory" (retired, see ADR-0008).

**App home** — `~/.jasper`, overridable with `JASPER_APP_HOME`. Holds `app.json`: `current_vault`, `recent_vaults`, and app-level (not vault-level) preferences. Distinct from any vault. Tests must isolate it or they read the developer's real registry.

**`.jasper/`** — the per-vault directory beside `notes/`. Holds `config.json`, `app.db` (the index), `logs/`, and the per-vault UI stores (`bookmarks.json`, `workspace.json`).

**Note** — a single `.md` file under the vault's `notes/`. Has a UUID for identity and a relative path for location. The UUID is what UI state references, so bookmarks and tabs survive rename and move.

**Registry** — the in-memory UUID ↔ relative-path map, hydrated from the index at boot. The bridge between "what the UI holds" and "what's on disk."

**Index** — the per-vault SQLite database (`.jasper/app.db`). Holds note metadata, FTS5 search, tags, backlinks, and MCP grants. **Derived.** Never referred to as a source of truth, never queried outside the `index` package.

**Reconcile** — the startup delta scan that walks the filesystem and syncs the index to it. Runs incrementally on every boot; a full rebuild is available via `POST /admin/reindex`.

**Attachment** — a non-markdown file stored at `notes/<note-dir>/attachments/`. Collisions auto-rename (`image-1.png`).

**Trash** — `.trash/` inside the vault. Deletes are soft: move to `.trash/`, restore by moving back and refreshing. Excluded from every index surface. See [ADR-0015](./docs/adr/0015-filesystem-native-soft-delete.md).

### The write path

**File-first save path** — the mandatory ordering: `fsstore.WriteAtomic` → `Index.Upsert` → `wshub.Broadcast`. Named because the order is the contract.

**Atomic write** — temp → fsync → rename → fsync parent, implemented in `fsstore`.

**Three-path migration resilience** — the migration runner's three outcomes: Path 1 applies migrations; Path 2 rolls back and restores the backup; Path 3 wipes and rebuilds from disk. Path 3 is safe *only* because of invariant 1.

**If-Match / stale write** — optimistic locking on note updates, compared against the file's modification time. A mismatch is a 409 and surfaces as a save-conflict banner, not a silent overwrite.

### Data fetching

**Resource** — a registered GET endpoint with a fetcher and a declared set of invalidating events: `createResource(key, fetcher, { invalidatedBy: [...] })`. Lives in `frontend/src/lib/resources/`. Components read it through `useResource`, never by calling a fetcher directly — the raw fetchers are module-private and a lint rule backstops it.

**Coalescing vs caching** — different things, deliberately. *Coalescing* is unconditional: concurrent identical requests (keyed by endpoint **plus params**) join one in-flight call. *Caching* is per-resource. A **pass-through** resource is uncached but still coalesced.

**Invalidate** — `invalidate(key)` starts a fetch strictly *after* the current one resolves. Reads may join an in-flight request; invalidations never may, because an invalidation has a "since" and a read doesn't.

**Boot-scoped** — a resource with no invalidating event, meaning a positive claim that its data cannot change during a session. An omitted `invalidatedBy` reads as a bug, not as silence.

### Sync

**Session** — one browser tab. Each generates a `session_id` used for WebSocket identity.

**Origin session** — the session that caused a change. Broadcasts exclude it, so a tab never receives an echo of its own write.

**Broadcast** — a WebSocket cache-invalidation event (`note.updated`, `note:created`, `file:moved`, `bookmarks:changed`, `vault.switching`/`vault.switched`, …). Server truth pushed to other sessions. Fire-and-forget: a broadcast failure never fails a write.

**Hot-swap** — switching the open vault without restarting the process. Ordered teardown (handler → DB pair → indexer → MCP → logger), then reopen. During the swap the HTTP handler is nil and every request returns 503, so no request can be served against a half-torn-down vault.

### Content model

**H1 binding** — the note's first heading *is* its displayed name *and* its filename. Editing the H1 renames the file; renaming the file rewrites the H1. There is no separate filename field exposed to the user. See [ADR-0009](./docs/adr/0009-filename-h1-binding.md).

**Frontmatter** — the YAML block at the top of a note, hidden in the editor by a decoration. **Properties** are the typed, user-editable view of that block.

**Wiki-link** — `[[Title]]` or `[[Title|Alias]]`. Title-based only; path syntax is deliberately not supported. Ambiguity resolves same-folder-first, then alphabetically. See [ADR-0010](./docs/adr/0010-title-only-wiki-links.md).

**Backlink / linked mention** — an inbound wiki-link, surfaced in the right rail with a per-mention excerpt.

**Tag** — authored as an inline `#hashtag` in the note body *and* carried in the frontmatter `tags:` array, with the two **two-way bound**: `ExtractBodyTags` reads the body, `RewriteFrontmatterTags` writes them back to frontmatter. The frontmatter copy is what makes tags travel with the file to any other markdown tool; the index is a derived mirror of both. Included in full-text search.

**Daily note** — `notes/daily/YYYY-MM-DD.md`, created from a template. **The date is always the user's local calendar day, never a UTC-derived one** — this has been a real, shipped bug more than once.

**Template** — a note whose body contains substitution variables (`{{date}}`, `{{title}}`, `{{cursor}}`, …). Templates are ordinary notes; they are *not* excluded from search or tags.

**Callout** — an admonition block, `> [!type] Title`, rendered inline in live preview.

### The editor and workspace

**Live preview** — the CodeMirror 6 decoration layer that renders markdown inline while typing, hiding syntax markers when the cursor is off the line. Bespoke, in `livePreviewPlugin.ts`. New markup extends it rather than adding a parallel plugin.

**Pane / pane tree** — the workspace is a per-vault tree of split panes. Each pane has its own tab strip, active tab, and breadcrumb, over a **shared document**.

**Shared document** — N live `EditorView`s mirroring one note through `sharedDocRegistry`, with a single undo owner that survives closing the pane that created it.

**`noteBufferController`** — the React-free module singleton that owns content, save, debounce, flush, and WebSocket reconciliation *per note*. Divergent state across panes is impossible by construction rather than by convention. Any second editing surface over the same bytes must route through it. See [ADR-0016](./docs/adr/0016-shared-document-single-writer.md).

**Flush** — draining a pending debounced edit before an action that would otherwise discard it (closing a tab, switching notes). Tab close does not fire blur; without an explicit flush the edit is lost.

**Tab** — an open note within a pane, keyed by note UUID, persisted per vault.

**Quick switcher (Cmd+O)** vs **command palette (Cmd+P)** — two distinct roles, matching Obsidian. Cmd+K is deliberately unbound. Don't merge them.

**Zen mode** — ephemeral hide-all-chrome toggle. Frontend-only, resets on reload, never persisted.

**Reading surface** — the centered 760px prose column. Title, breadcrumb, and body share one horizontal column; changes that shift them relative to each other are regressions.

### Server and access

**Bind posture** — the HTTP listener defaults to `127.0.0.1` and is LAN-bindable only via the `--bind` flag or the `server.bind` config field. The MCP listener is loopback-*enforced*. These are different guarantees; don't conflate them. See [ADR-0014](./docs/adr/0014-retire-settings-bind-control.md).

**Grant** — a per-folder ACL entry authorizing MCP write access. Default-deny: a user who grants nothing has an AI with no write access. Grants are the *only* control over MCP access.

**MCP listener** — the second HTTP listener (default port 6684) exposing notes to Claude Desktop via the Model Context Protocol.

**Doctor / status / install / uninstall** — the CLI subcommands. `install` registers a launchd LaunchAgent (macOS) or systemd user unit (WSL2).

**Port 6683** — the default HTTP port. T9 keypad spelling of "NOTE", chosen to be on-theme and well clear of common dev ports (3000, 5173, 8080). Overridable via `server.port`. The MCP listener defaults to 6684.

**Canonical path** — every path is normalized to **NFC + lowercase** before any read, write, or index lookup, so macOS (case-insensitive) and Linux (case-sensitive) vaults behave identically. Case-insensitive collisions are rejected with 409. See [ADR-0026](./docs/adr/0026-path-canonicalization.md).

---

## Terms we deliberately don't use

| Don't say | Say | Why |
|---|---|---|
| "data directory", `--data-dir`, `JASPER_DATA_DIR` | **vault**, `--vault` | Retired in ADR-0008. The old framing created an unfixable asymmetry between the bootstrap path and the user-selected path. |
| "the database has the notes" | the **index** is derived from the files | Invariant 1. The phrasing matters because it's the assumption that breaks first. |
| "enable MCP" / "the MCP toggle" | **grant** a folder | The global toggle was removed. Access is governed solely by grants. |
| "loopback-only" (of the HTTP listener) | loopback **by default**, LAN-bindable opt-in | Only the MCP listener is loopback-*enforced*. Asserting otherwise in docs has caused a withdrawn ADR already. |
| "native drag and drop" | **pointer events** | Native HTML5 DnD is unreliable here and has produced false-passing tests twice. See [ADR-0017](./docs/adr/0017-pointer-events-for-drag.md). |

---

## Where everything lives

| | |
|---|---|
| **This file** | Vocabulary and invariants |
| [`docs/adr/`](./docs/adr/) | Decisions and their rationale — the complete record |
| [`CONVENTIONS.md`](./CONVENTIONS.md) | Process: how we build, test, and verify |
| [`.scratch/`](./.scratch/) | Live work — in-flight, ready-to-start, and backlog |
| `DESIGN.md` | Pre-implementation architectural reference, still accurate on the locked shape |

Four milestones (v1.0–v1.4) were built under a planning system whose artifacts — roadmaps, phase plans, verification logs, UAT rounds, retrospectives — have been removed after their durable content was mined into the files above. They remain retrievable from git history if you need the execution record behind a decision.

**Don't reconstruct that structure.** New work goes in `.scratch/`; new decisions amend or extend `docs/adr/`.

# Lightweight Browser-Based Markdown Notes App

## Initial Design Document

> **Status**: Pre-implementation design. This document defines architectural constraints and core behaviors. Implementation details, UI decisions, and library choices within bounds are intentionally left open.

---

## 1. Project Overview

A lightweight, self-hosted Obsidian-inspired markdown notes application that runs entirely in the browser, backed by a containerized server. The primary goals are:

- Markdown-first note editing with a live-preview feel
- Folder-based organization with drag-and-drop
- Backlinking, tagging, and daily notes
- Easy self-hosting via Docker Compose
- Upgradeable via database migrations with three-path resilience

---

## 2. Technology Stack

### Decided

| Layer               | Choice                        | Rationale                                                    |
| ------------------- | ----------------------------- | ------------------------------------------------------------ |
| Frontend language   | TypeScript                    | Type safety, maintainability                                 |
| Frontend framework  | React                         | Ecosystem, component model                                   |
| Frontend build tool | Vite                          | Fast dev server, clean SPA output                            |
| Backend language    | Go                            | Single binary, low memory, strong SQLite and file I/O story  |
| Backend router      | `chi` or `net/http` (stdlib)  | Lightweight; no framework needed at this scale               |
| API contract        | OpenAPI spec + codegen        | Replaces shared types across the language boundary; see §3   |
| Containerization    | Docker + Docker Compose       | Self-hosting simplicity                                      |
| Primary data store  | SQLite (`modernc.org/sqlite`) | Pure-Go driver, no CGo required, no native deps in container |
| Config format       | JSON                          | Human-readable, easy to edit                                 |
| Note format         | Markdown (`.md`)              | Plain-text portability                                       |

### Open for Implementation Decision

| Layer                   | Options                                    | Notes                                                |
| ----------------------- | ------------------------------------------ | ---------------------------------------------------- |
| OpenAPI codegen tool    | `oapi-codegen`, `ogen`                     | Generates Go server stubs + TypeScript fetch client  |
| Markdown editor library | CodeMirror 6, Monaco, ProseMirror          | See §6.3                                             |
| Migration runner        | `golang-migrate`, custom SQL runner        | Must support versioned files embedded via `go:embed` |
| File tree UI            | Custom, `react-arborist`, `dnd-kit`        | Must support drag-and-drop                           |
| WebSocket library       | `gorilla/websocket`, `nhooyr.io/websocket` | For live file-change events                          |

---

## 3. Architecture: Go Backend + Vite Frontend

### Structure

The project is two distinct build artifacts wired together by Docker Compose:

- **Frontend**: Vite + React SPA, built to static files (`dist/`)
- **Backend**: Go binary that serves the API, WebSocket, and the built frontend static files

There is no Node runtime in production. The Go binary serves `dist/` from an embedded filesystem (`go:embed`) or a mounted path. This means the final Docker image is a single Go binary — no Node, no npm, nothing else.

```
repo/
  frontend/        ← Vite + React + TypeScript
  backend/         ← Go module
    cmd/server/
    internal/
      api/         ← HTTP handlers
      db/          ← SQLite + migrations
      notes/       ← file I/O, backlink parsing
    migrations/    ← embedded SQL files
  api/
    openapi.yaml   ← source of truth for API contract
  docker-compose.yml
  Dockerfile
```

### API Contract: OpenAPI + Codegen

Since the frontend is TypeScript and the backend is Go, shared types are replaced by an **OpenAPI 3.1 spec** (`api/openapi.yaml`). Codegen runs as part of the build:

- **Go side**: `oapi-codegen` generates server interface stubs and request/response types. Handlers implement the generated interface — compile-time enforcement that all routes are implemented.
- **TypeScript side**: `openapi-typescript` generates types; `openapi-fetch` provides a typed fetch client. No hand-written API client code.

The spec is the contract. Neither side drifts from it silently.

### Dockerfile (multi-stage)

```dockerfile
# Stage 1: Build frontend
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Go binary
FROM golang:1.23-alpine AS backend
WORKDIR /app
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
COPY --from=frontend /app/frontend/dist ./internal/static/dist
RUN go build -o server ./cmd/server

# Stage 3: Minimal runtime
FROM alpine:3.20
COPY --from=backend /app/server /server
ENTRYPOINT ["/server"]
```

The final image is ~20MB. No Node, no shell required.

---

## 4. Data Architecture

### 4.1 Volume Structure

The user defines one Docker volume (or bind mount) for all application data:

```
/data/                        ← user-defined volume root
  notes/                      ← all markdown notes and attachments
    daily/                    ← daily notes live here
    [user folders]/
  storage/
    app.db                    ← SQLite database (live)
    app.db.backup             ← pre-migration backup (single rolling copy)
    config.json               ← application configuration
```

The `notes/` directory is the source of truth for file content. SQLite is the source of truth for metadata, indexes, and relationships.

### 4.2 SQLite Driver and Migrations

**Driver**: `modernc.org/sqlite` — pure Go, no CGo, no native dependencies. This is critical for the minimal Docker image; CGo-based drivers (`mattn/go-sqlite3`) require a C toolchain in the runtime image.

**Migrations**: SQL files embedded into the Go binary via `go:embed`. The migration runner (either `golang-migrate` pointed at the embedded FS, or a simple custom runner) executes them at startup against a `schema_migrations` tracking table. This means migrations ship with the binary — no separate migration files need to be distributed or mounted.

### 4.3 SQLite Schema (Initial, Pre-Migration)

The following tables are expected. Exact column types and indexes are left to the implementer.

**`notes`**

- `id` — primary key (UUIDs preferred for stability across renames)
- `path` — relative path from `notes/` root
- `title` — derived from filename or first heading
- `created_at`, `updated_at`
- `checksum` or `last_modified` — for detecting file changes

**`backlinks`**

- `source_note_id`
- `target_note_id`
- Links are derived from `[[wiki-link]]` syntax in note content

**`tags`**

- `id` — primary key
- `name` — normalized tag string (lowercase, trimmed)

**`note_tags`** (junction table)

- `note_id` — foreign key to `notes`
- `tag_id` — foreign key to `tags`

**`daily_notes`**

- `date` — YYYY-MM-DD
- `note_id` — foreign key to `notes`

**`schema_migrations`**

- `version` — migration filename/number
- `applied_at` — timestamp

> **Tags source of truth**: Tags are stored in YAML frontmatter in the `.md` file itself. SQLite (`tags`, `note_tags`) is a queryable index only. On every save, the server parses frontmatter and syncs the index. On re-index, all tags are fully recoverable from the filesystem with no data loss.
>
> **Frontmatter format**:
>
> ```
> ---
> tags: [project, reference, go]
> ---
> ```

### 4.4 Migration Resilience

The database is entirely derived from the `notes/` filesystem. Every row in every table can be reconstructed by walking the files. This is the foundational property that makes strong migration resilience possible — wiping SQLite is never data loss.

Migrations use a **backup-first** strategy, with three explicit recovery paths available in sequence.

---

**Startup sequence:**

```
1. Check schema_migrations table for pending migrations
2. If none pending → run incremental re-index, then start normally
3. If pending:
   a. Copy app.db → app.db.backup (overwrite any existing backup)
   b. Run each pending migration in sequence, each inside its own transaction
   c. On success → delete app.db.backup, run incremental re-index, start normally
   d. On failure → PATH 1 (see below)
```

---

**PATH 1 — Backup Restore (automatic)**

Triggered immediately on any migration failure. No user action required.

```
1. Restore app.db.backup → app.db
2. Start the app on the restored (pre-migration) schema — fully functional
3. Surface a persistent error banner in the UI (see UI spec below)
```

The user is on the last known-good schema. All features work. The only limitation is that the new schema version has not been applied.

---

**PATH 2 — Truncate and Rebuild (user-initiated)**

Available from the error banner after a Path 1 restore. This is the escape hatch when the user needs to push forward to the new schema rather than stay on the old one.

```
1. Drop all tables except schema_migrations
2. Re-run all migrations from 001 on a clean schema
3. If migrations succeed → run full re-index from filesystem, start normally
4. If migrations fail again → PATH 3
```

Because the filesystem is the source of truth, dropping all tables loses nothing. The re-index after clean migration restores all notes, backlinks, tags, and daily note associations from the `.md` files.

---

**PATH 3 — Unrecoverable (log and halt)**

Triggered only if Path 2 also fails — meaning the migration SQL itself is broken and cannot run against a clean schema. This is a code defect, not a data problem.

```
1. Do not start the application
2. Log the full error with migration version, SQL statement, and database error
3. Display a static error page (not the full app UI) explaining:
   - The migration is broken and requires a fix
   - The backup (app.db.backup) is intact
   - Steps to restore manually if needed
4. Exit with a non-zero status code (surfaces in Docker logs / compose health checks)
```

This is the one case where the app does not start. It is the right behavior — starting on a broken schema would corrupt data going forward.

---

**UI error banner spec (Path 1 state):**

Displayed persistently across the top of the app until dismissed or resolved. Contains:

- Which migration failed and the error summary
- Confirmation that the database was restored and no data was lost
- Two actions: **"Reset and rebuild database"** (triggers Path 2) and **"Dismiss"**
- A link to the full logs

---

**Re-index behavior:**

Re-index is independent of migration failure. It runs in two modes:

- **Incremental** (automatic, every startup): checks files modified since the last `updated_at` in the DB, syncs only changed records. Fast for typical use.
- **Full** (triggered by Path 2, manual admin action, or `/api/v1/admin/reindex` endpoint): walks all files, rebuilds all derived tables from scratch. Complete recovery from any state.

---

**Migration files** are SQL, embedded in the Go binary via `go:embed migrations/*.sql`, prefixed numerically: `001_initial.sql`, `002_add_tags.sql`. Applied versions are tracked in `schema_migrations` inside the DB itself.

---

## 5. Backend API Design

The backend exposes two interfaces:

### 5.1 REST API

All routes prefixed `/api/v1/`.

| Method   | Path                             | Description                                 |
| -------- | -------------------------------- | ------------------------------------------- |
| `GET`    | `/notes`                         | List all notes (metadata only)              |
| `GET`    | `/notes/:id`                     | Get note content + metadata                 |
| `POST`   | `/notes`                         | Create a new note                           |
| `PUT`    | `/notes/:id`                     | Update note content                         |
| `DELETE` | `/notes/:id`                     | Delete a note                               |
| `POST`   | `/notes/:id/move`                | Move/rename a note                          |
| `GET`    | `/notes/:id/backlinks`           | Get notes linking to this note              |
| `GET`    | `/folders`                       | Get directory tree                          |
| `POST`   | `/folders`                       | Create a folder                             |
| `DELETE` | `/folders/:path`                 | Delete a folder                             |
| `POST`   | `/folders/move`                  | Move/rename a folder                        |
| `POST`   | `/attachments/:noteId`           | Upload attachment for a note                |
| `GET`    | `/attachments/:noteId/:filename` | Serve attachment file                       |
| `GET`    | `/daily-notes/:date`             | Get or create daily note for date           |
| `GET`    | `/search?q=`                     | Full-text search                            |
| `GET`    | `/tags`                          | List all tags with note counts              |
| `GET`    | `/tags/:name/notes`              | List notes with a given tag                 |
| `GET`    | `/notes/:id/tags`                | Get tags for a specific note                |
| `POST`   | `/admin/reindex`                 | Trigger a full re-index from the filesystem |

### 5.2 WebSocket

WebSocket is a **required** part of the architecture. The app is designed to run as a persistent browser home page across multiple concurrent sessions. The WebSocket connection has one job: broadcast API-originated mutations to all other connected sessions so they stay in sync.

External filesystem changes (direct file edits, sync tools like Syncthing) are **not** detected automatically. The sidebar toolbar provides a manual **Refresh** action for this purpose (see §6.3). This eliminates the need for a filesystem watcher, a feedback-loop suppression mechanism, and the ambiguity of dual event sources.

The server maintains a **connection hub** — a registry of all active WebSocket connections. Any mutation via the API is broadcast to all connected clients immediately after the operation succeeds.

**Connection lifecycle:**

- Client connects at `ws://host/ws` on app load
- Server assigns a unique `session_id` per connection and sends it in the initial handshake
- Client includes its `session_id` in all mutating API requests (as a header: `X-Session-ID`)
- Server tags outbound broadcast events with the `origin_session_id` that caused them
- Clients ignore events where `origin_session_id` matches their own — their local state is already current

**Event schema:**

All events follow a consistent envelope:

```json
{
    "event": "note:updated",
    "origin_session_id": "abc123",
    "payload": { "id": "...", "path": "...", "updated_at": "..." }
}
```

**Events broadcast to all sessions:**

| Event              | Payload                          | Client action                                      |
| ------------------ | -------------------------------- | -------------------------------------------------- |
| `note:created`     | `id`, `path`, `title`            | Refresh file tree                                  |
| `note:updated`     | `id`, `path`, `updated_at`       | See stale-write detection below                    |
| `note:deleted`     | `id`, `path`                     | Remove from file tree; close if open               |
| `note:moved`       | `id`, `old_path`, `new_path`     | Update file tree; update editor path if open       |
| `folder:created`   | `path`                           | Refresh file tree                                  |
| `folder:deleted`   | `path`                           | Refresh file tree; close any open notes under path |
| `folder:moved`     | `old_path`, `new_path`           | Update file tree                                   |
| `tags:updated`     | `note_id`, `tags[]`              | Refresh tag list; update note if open              |
| `reindex:started`  | —                                | Show progress indicator in toolbar                 |
| `reindex:complete` | `notes_indexed`                  | Refresh file tree and tag list                     |
| `migration:status` | `status`, `migration`, `message` | Show/dismiss error banner                          |

**Stale-write detection:**

Each note save returns an `updated_at` timestamp. The client stores this per open note as its `last_known_updated_at`.

When a `note:updated` event arrives for a note the current session has open with unsaved changes:

1. Compare the event's `updated_at` against the session's `last_known_updated_at`
2. If they differ, another session saved this note while this one had unsaved edits
3. Display a non-blocking conflict warning: _"This note was updated in another session. Save anyway, or discard your changes?"_
4. **Save anyway**: writes current content, becomes the new canonical version (last write wins, user-acknowledged)
5. **Discard**: reloads note content from the server

If the note has no unsaved changes when `note:updated` arrives, silently reload the content — no prompt needed.

**Reconnection:**

The client implements automatic WebSocket reconnection with exponential backoff. On reconnect:

1. Re-fetch the file tree
2. Re-fetch the currently open note
3. Resume normal event handling

The toolbar connection status indicator (see §6.3) reflects connected/reconnecting state.

### 5.3 File I/O Behavior

- The server reads/writes `.md` files directly to the `notes/` volume directory.
- SQLite is updated **after** successful file writes.
- If SQLite and the filesystem diverge (detected on startup or via re-index), the filesystem wins.
- Attachments are stored at `notes/[note-dir]/attachments/[filename]`. The `attachments/` folder is created on first attachment upload for that note.

---

## 6. Frontend Architecture

### 6.1 Session Sync

The app is designed to run as a persistent browser home page — multiple tabs or windows open simultaneously are the expected normal state. The frontend WebSocket connection is the spine of all live updates.

**On connect:**

- Establish WebSocket connection, store the assigned `session_id`
- Attach `session_id` to all mutating requests via `X-Session-ID` header

**Incoming event handling:**

| Event source                              | Behaviour                               |
| ----------------------------------------- | --------------------------------------- |
| Own session (`origin_session_id` matches) | Ignore — local state is already current |
| Other session                             | Apply update (see below)                |

**Applying updates without disrupting the user:**

- **File tree changes** (`note:created`, `note:deleted`, `note:moved`, `folder:*`): refresh the tree data in the background; the tree re-renders without collapsing open folders or losing scroll position
- **Note content changed, no unsaved edits**: silently reload the note content and update `last_known_updated_at`
- **Note content changed, unsaved edits exist**: show stale-write warning (see §5.2)
- **Note deleted while open**: show a non-blocking banner — _"This note was deleted in another session"_ — and leave the editor content intact so the user can recover it if needed
- **Tags updated**: refresh the tag browser and the open note's tag display

**Reconnection handling:**

On WebSocket disconnect (network drop, server restart, container update), the client reconnects with exponential backoff. On successful reconnect, it re-fetches the file tree and currently open note before resuming event handling. Connection state is reflected in the sidebar toolbar (see §6.3).

### 6.2 Layout

Three-panel layout:

```
┌─────────────┬──────────────────────────┬─────────────┐
│  Sidebar    │      Editor / Viewer      │  (future)   │
│  File Tree  │                           │  Backlinks  │
│             │                           │  Panel      │
└─────────────┴──────────────────────────┴─────────────┘
```

The sidebar and editor are the core UI. The right panel can be collapsed initially; backlinks should appear at the **bottom of the editor view** for v1.

### 6.3 File Tree (Sidebar)

**Toolbar:**

A compact icon bar at the top of the sidebar. Left to right:

| Icon                  | Action                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New file              | Create a new note in the currently selected folder, or root if none selected                                                                                                                |
| New folder            | Create a new folder at the current location                                                                                                                                                 |
| Search                | Open the search input (replaces file tree with results)                                                                                                                                     |
| Refresh               | Re-fetch the file tree and SQLite index from the filesystem; triggers an incremental re-index on the server. Intended for picking up external changes (direct file edits, sync tools, etc.) |
| Connection status dot | Green = WebSocket connected; amber = reconnecting. Not interactive — indicator only                                                                                                         |

The refresh action calls `POST /api/v1/admin/reindex` (incremental mode) and then re-fetches the file tree on completion. Progress is indicated via the `reindex:started` / `reindex:complete` WebSocket events.

**File tree:**

- Displays the full folder/file hierarchy
- Folders are collapsible; open/closed state persists in local storage
- Files and folders are **draggable** to new locations within the tree
- Right-click context menu (or hover icon buttons): rename, delete
- Daily Notes has a dedicated shortcut button (calendar icon) in the toolbar or pinned at the top of the tree — implementer's choice
- Active note is highlighted

**Drag-and-drop constraint**: Moving a note must also update all backlinks pointing to it (path-based links must be updated; ID-based links in SQLite are unaffected).

### 6.4 Editor

The editor is the central design decision. Requirements:

- Edits raw markdown
- **Live syntax highlighting** as you type (not a split preview pane)
- **Partial rendering**: the following should be visually applied inline:
    - Headings: rendered font size and weight
    - Bold / italic: rendered weight/style
    - Bullet lists: rendered as actual bullets (not `- ` text)
    - Blockquotes: rendered with left border or indentation
    - Inline code: monospace, styled background
    - Horizontal rules: rendered as visual dividers
- Syntax markers (`#`, `**`, `_`) may remain faintly visible or hidden — implementer's call, but the rendered output should dominate visually
- Code blocks: syntax highlighted by language
- `[[wiki-link]]` syntax: rendered as a clickable link, opens the target note
- Image attachments: rendered inline if the path resolves
- Non-image file links: rendered as a placeholder with a file-type icon

**Recommended approach**: CodeMirror 6 with a custom decoration/rendering extension. This gives fine-grained control over the "rendered markdown in editor" feel. ProseMirror is a valid alternative with higher implementation complexity.

### 6.5 Backlinks

- Displayed at the **bottom of the editor pane**, below the note content
- Section heading: "Linked from" or "Backlinks"
- Each backlink shows: note title, and optionally a short excerpt of the context around the link
- Clicking a backlink navigates to that note
- Backlinks are fetched from SQLite on note open and updated reactively after saves

### 6.6 Daily Notes

- Triggered by a "Today" button in the sidebar
- Behavior:
    1. Compute today's date as `YYYY-MM-DD`
    2. Call `GET /api/v1/daily-notes/:date`
    3. If note exists: open it
    4. If not: server creates `notes/daily/YYYY-MM-DD.md` with template content, inserts into DB, returns note — client opens it
- Template (v1): `# YYYY-MM-DD\n\n`
- The `daily/` folder should be visually distinct in the sidebar (e.g., calendar icon prefix)

### 6.7 Attachments

- Drag-and-drop a file onto the editor, or paste from clipboard
- Server receives the file via `POST /api/v1/attachments/:noteId`
- Server stores it at `notes/[note-dir]/attachments/[filename]`
- For **images**: inserts `![filename](attachments/filename)` into the editor at cursor position; rendered inline in editor
- For **non-images**: inserts a link `[filename](attachments/filename)` with a file-type icon rendered inline (PDF icon, video icon, etc.)

---

## 7. Tagging System

### Source of Truth

Tags live in YAML frontmatter at the top of each `.md` file. This makes them portable, human-editable, and fully recoverable from the filesystem without the database.

```
---
tags: [project, reference, go]
---

Note content starts here.
```

The frontmatter block is parsed on every save. Tags are normalized (lowercase, trimmed) before being written back to the file and synced to SQLite.

### Editing Tags

Tags are edited directly in the frontmatter block within the editor. The editor should treat the frontmatter block distinctly — visually styled as metadata (subdued, monospace, or a structured display above the note body). Implementer's choice on whether to render it as raw YAML or a tag-chip UI above the editor body; both are acceptable for v1.

### SQLite Sync

On every note save:

1. Parse frontmatter for `tags` field
2. Normalize all tag values
3. Upsert any new tags into the `tags` table
4. Replace all `note_tags` rows for this note with the current set (delete old, insert new — in a transaction)
5. Remove any `tags` rows with zero `note_tags` references (cleanup orphaned tags)

### Tag Index and Search

- `GET /api/v1/tags` returns all tags with their note counts, sorted alphabetically
- `GET /api/v1/tags/:name/notes` returns notes with that tag (metadata only)
- Tags are also included in FTS5 full-text search — tag values are indexed alongside note content
- The sidebar should include a tag browser section (collapsible), listing all tags; clicking a tag filters the file tree to matching notes

### Re-index Behavior

Because tags are in frontmatter, a full re-index completely reconstructs the `tags` and `note_tags` tables by walking all `.md` files. No tag data is lost if the database is wiped.

---

## 8. Backlinking System

### Detection

- On every note save, the server parses the note content for `[[Note Title]]` or `[[Note Title|Display Text]]` patterns
- Resolved against the `notes` table by title or path
- The `backlinks` table is updated: old links for this source are deleted, new ones inserted (within a transaction)

### Resolution Strategy

- Links are matched **by note title** (filename without `.md`) first
- If ambiguous (two notes with same title in different folders), preference is given to notes in the same folder, then alphabetical
- Unresolved links (target doesn't exist) are stored as `pending` and rendered with a distinct style (e.g., dashed underline)

### Display

- Backlinks are shown at the bottom of the reading/editing view
- Updated on save without requiring a page reload

---

## 9. Search

- Full-text search over note content **and tag values**
- Implemented via SQLite FTS5
- The FTS virtual table indexes note body content and frontmatter tags
- Search UI: a search input in the sidebar header, results replace the file tree temporarily
- Results show: note title, path, matching excerpt, and any matching tags
- Tag filter can be combined with text search (e.g., show results matching query AND having tag `project`)

---

## 10. Docker Compose

```yaml
# docker-compose.yml (illustrative — not final)
services:
    app:
        build: .
        ports:
            - "3000:3000"
        volumes:
            - notes-data:/data
        environment:
            - DATA_DIR=/data

volumes:
    notes-data:
        driver: local
        # User can override with a bind mount:
        # driver_opts:
        #   type: none
        #   o: bind
        #   device: /path/on/host
```

- Multi-stage Dockerfile: Node build stage (frontend) → Go build stage (backend + embed frontend) → `alpine` runtime stage with only the Go binary
- The Go binary serves the built frontend from an embedded filesystem or a static path
- No Node runtime, no npm, no separate web server in the final image
- `DATA_DIR` environment variable controls the volume mount path inside the container
- Final image target size: ~20–30MB

---

## 11. Configuration (`config.json`)

Stored at `/data/storage/config.json`. Example shape:

```json
{
    "appName": "My Notes",
    "dailyNotes": {
        "folder": "daily",
        "template": "# {{date}}\n\n"
    },
    "editor": {
        "fontSize": 15,
        "lineHeight": 1.6,
        "vimMode": false
    },
    "theme": "dark"
}
```

Config is read at server start and can be reloaded without restart (file watcher or manual reload endpoint).

---

## 12. What's Intentionally Left Open

The following are **not specified here** and should be decided during implementation:

| Decision                          | Guidance                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------- |
| OpenAPI codegen tool              | `oapi-codegen` (simpler) vs `ogen` (stricter); both work                          |
| Go HTTP router                    | stdlib `net/http` is sufficient; `chi` adds route grouping and middleware cleanly |
| Exact UI component library        | Headless (Radix, shadcn) preferred; avoid heavy opinionated UI kits               |
| Color scheme / theme              | Dark and light modes expected; exact palette is a design decision                 |
| Editor markdown rendering details | CodeMirror decoration strategy is the implementer's call                          |
| Real-time collaboration           | Out of scope for v1                                                               |
| Auth / multi-user                 | Out of scope for v1; single-user assumed                                          |
| Mobile layout                     | Not a priority for v1; desktop-first                                              |
| Plugin system                     | Out of scope; no extension API needed                                             |
| Export (PDF, HTML)                | Nice-to-have, not required                                                        |
| Graph view (like Obsidian's)      | Out of scope for v1                                                               |

---

## 13. Non-Functional Requirements

- **Performance**: The file tree should handle 1,000+ notes without noticeable lag (virtualize if needed)
- **Startup time**: Migrations + re-index should complete in under 5 seconds for typical note counts (<5,000 notes)
- **No data loss**: All writes are atomic. Never truncate before confirming write success
- **Offline**: The app should function fully offline once loaded (no CDN dependencies at runtime)
- **Graceful degradation**: If SQLite is unavailable, the app should still allow reading files directly from the filesystem

---

## 13. Open Questions for Review

Before implementation begins, confirm:

1. **OpenAPI codegen tool**: `oapi-codegen` vs `ogen` — both are solid; `ogen` is stricter and generates more complete code but has a steeper learning curve.
2. **Wiki-link syntax**: Support `[[Title]]` only, or also `[[path/to/note]]` and `[[Title|Alias]]`?
3. **Conflict resolution**: If two notes have the same title in different folders, what's the preferred backlink resolution behavior?
4. **Re-index strategy**: Should re-index run automatically on startup (fast path, only check modified files) or only on migration failure?
5. **Attachment naming**: On filename collision in `attachments/`, overwrite or rename (e.g., `image-1.png`)?

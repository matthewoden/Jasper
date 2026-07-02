# 07 — Data Durability & Resilience

The atomic-write path, soft-delete, and reconcile's skip-and-continue behavior are genuinely well built (details in "Verified sound"). The durability risk is concentrated almost entirely in **one dimension: the user's *other* tools also touch the vault** — a second editor, and especially file-sync clients (Dropbox / iCloud / Syncthing) pointed at the notes folder, which is the explicitly stated realistic deployment. The current architecture reconciles disk→index only at startup, on vault switch, and on manual reindex — never while running.

Two of these (DUR-02, DUR-04) are also the answer to "does this account for WSL and testing?" — see the **Verification & platform notes** at the end.

---

## DUR-01 — No external-change detection: the vault silently desyncs whenever another tool touches it

**Priority:** HIGH · **Executor:** opus · **Effort:** M–L

### Evidence

No filesystem watcher exists — `fsnotify` is only an indirect go.mod dependency, nothing in `backend/internal` imports it, and `config.go:7` documents "No filesystem watcher / hot-reload; restart picks up changes." `index/reconcile.go` is the only sync mechanism; its callers are startup (`lifecycle.go:263`), vault switch (`lifecycle.go:451`), and manual `POST /admin/reindex` only. No periodic loop.

### Scenario

Jasper runs 24/7 as a launchd agent with the vault in a Dropbox folder. A note is created/edited/deleted on another device and syncs to disk. Jasper is running, so no reconcile fires:
- New `.md` files never appear in the tree or search.
- Deleted files still show in the tree; clicking one 404s.
- Edited files show stale content in the index and, if opened, in the editor.

The only recovery is a restart or the user knowing to hit reindex. For an app whose promise is "finding notes feels trustworthy," the index silently diverging from disk for hours is the single biggest durability gap.

### Fix

Add an `fsnotify` watcher on `notesDir` (recursive; debounce ~300ms to coalesce sync bursts). On events, run a scoped incremental reconcile for the affected paths and `wshub.Broadcast` the matching `note:*` / `folder:*` events — the frontend already handles all of these (`useSessionSync.ts:119-149`). Ignore `.trash/`, `.jasper/`, dotfiles, `*.tmp.*` (already the walk's skip set). Fall back to startup reconcile if the watcher fails to arm. This is the structural fix that also makes DUR-02's conflict detection proactive.

### Done when

Integration test: with the server running, write a `.md` directly to `notesDir` → it appears in `GET /tree` and search within ~1s and a `note:created` broadcast fires. Same for external edit and delete.

---

## DUR-02 — Open editor silently overwrites concurrent external edits

**Priority:** HIGH · **Executor:** opus · **Effort:** M · *(same root as DI-03 / SEC — the external-edit facet)*

### Evidence

The frontend save omits If-Match (`EditorPane.tsx:334`; keepalive saves at `:483,:501` too), so the backend optimistic lock (`service.go:141` `if ifMatch != ""`) is never armed. `onNoteUpdated` (`EditorPane.tsx:525`) only fires from a WS broadcast, and external edits produce no broadcast (DUR-01) — so the open editor never learns the file changed underneath it.

### Scenario

`Note.md` is open in Jasper. The same note is edited on another device and syncs to disk. Jasper's editor still holds the old buffer. The user types one character (or the tab blurs → autosave/keepalive fires) → PUT with no If-Match → `WriteAtomic` overwrites the file → the externally-synced edit is **gone**, unrecoverable (no version history, DUR-07). The atomic write is durable; it durably writes the wrong thing.

### Fix

This is DI-03 seen from the sync angle — fix them together: (a) send `If-Match` on every PUT (see DI-03/DI-04 for the version-comparator caveat — mtime-seconds is too coarse; use size+mtime or a checksum), surfacing the existing conflict banner on 409; (b) pair with DUR-01's watcher so an external edit to the open note raises the banner proactively rather than only on the next save.

### Done when

Two-source test: open a note, modify it on disk externally, trigger an autosave → conflict banner appears, on-disk external content is preserved.

---

## DUR-03 — Soft-delete has no in-app restore or retention

**Priority:** MEDIUM · **Executor:** sonnet (endpoint + tree section); opus (retention policy) · **Effort:** M

### Evidence

`Service.Delete` (`service.go:397`) and `DeleteFolder` (`:542`) trash to `<dataDir>/.trash/` with no-overwrite suffixing (`ops.go:287,313`) — good, better than a hard unlink, and MCP `delete_note` inherits it (`mcp/tools.go:443`). But there is **no** restore/untrash endpoint (grep of `openapi.yaml` + handlers is clean), no retention/cleanup, and no UI affordance.

### Scenario

A confused MCP client or a misclick calls `delete_note`. The note is safe in `.trash/`, but the user can only recover it by knowing `.trash/` exists and moving the file back via Finder/shell. Meanwhile trash grows unbounded forever inside the source-of-truth folder.

### Fix

Add `GET /admin/trash` + `POST /admin/trash/{name}/restore` (restore = move back to `notes/` with collision suffixing, then reindex + broadcast). Surface a Trash section or a restore toast in the tree. Optionally an opt-in age-based purge (e.g. 30 days) at startup.

---

## DUR-04 — Filename case/NFC-NFD drift hides externally-created notes on WSL

**Priority:** MEDIUM · **Executor:** opus · **Effort:** M · *(WSL-specific; verified at source)*

### Evidence

`fsstore.Canonicalize` normalizes to **lowercase + NFC** (`canonicalize.go:51`) and returns the *reconstructed* path `filepath.Join(rootDir, cleaned)`. `WalkVault` stores that as `AbsPath` (`walk.go:81,98`) and reconcile reads via `os.ReadFile(fm.AbsPath)` (`reconcile.go:77`), skipping on failure (`:78-82`).

### Scenario

On case-sensitive ext4 (WSL2), an externally-created file whose on-disk name has **uppercase letters or NFD-encoded accents** (common after a macOS→sync→Linux round-trip) is read via the lowercased/NFC-reconstructed path, which is a different byte sequence than what's on disk → `os.ReadFile` fails → the note is **omitted from the index entirely**, invisible in tree and search though safely on disk. macOS APFS masks this (normalization- and case-insensitive lookup); it surfaces specifically on WSL. Jasper's own files are unaffected (it writes lowercase-NFC), so this bites external/sync-created files only — exactly the DUR-01 population.

### Fix

Preserve the *actual on-disk* path for I/O while using the lowercase-NFC form only as the index/DB key. In `WalkVault`, read via the real walked `path` (from `filepath.WalkDir`), not the reconstructed `AbsPath`. Optionally normalize-on-adopt: rename external NFD/uppercase files to the canonical form during reconcile so representations converge.

### Done when

A reconcile test **run on a case-sensitive filesystem** (Linux CI / the fake-WSL harness — it passes vacuously on macOS): drop a file named `Über Note.md` (uppercase + NFD) into `notesDir`, reconcile → it's indexed and readable.

---

## DUR-05 — Change detection is mtime-in-seconds only; no size or checksum comparison

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** S

### Evidence

`reconcile.go:67` skips when `cur.MTime == fm.MTimeUnix`; `MTimeUnix` is `info.ModTime().Unix()` — whole seconds (`walk.go:100`). `Checksum` is always `""` (`reconcile.go:92`, `service.go:169`) and `SizeBytes` is stored but never compared.

### Scenario

A sync/restore flow rewrites content while **preserving** the original mtime (some conflict-resolution tools do), or an external edit lands in the same wall-clock second as the indexed value → reconcile sees equal mtimes → skips → the change is never indexed, even across restart. (This does *not* undermine crash recovery of Jasper's own writes — a crash between `WriteAtomic` and `Upsert` leaves index-mtime ≠ file-mtime, so reconcile correctly re-indexes. The gap is purely external edits that don't advance mtime.)

### Fix

Compare `(size, mtime)` as a cheap first gate; the `Checksum` field already exists — populate and compare it when size matches but suspicion remains. At minimum add the size comparison — near-free, catches most content-preserving-mtime cases.

---

## DUR-06 — Crash mid bulk-rewrite (tag/wikilink rename) leaves the vault half-applied

**Priority:** MEDIUM · **Executor:** opus · **Effort:** M

### Evidence

`RenameTagAcrossVault` (`service.go:737`), `DeleteTagAcrossVault` (`:804`), `RenameRewriteWikilinks` (`:880`) loop `WriteAtomic` per file with an in-error rollback pass — but no journal, so an *error return* rolls back while a **process kill/power loss mid-loop** does not.

### Scenario

Rename a tag on 200 notes; power loss after 120. Each file is individually intact (atomic writes) and reconcile re-indexes correctly, so index matches disk — but 120 notes have the new tag and 80 the old. Silently half-applied; the user must notice and re-run. Not corruption, but confusing. (This is the durability facet of BE-07, which extracts this triplicated logic — do them together.)

### Fix

Write an operation manifest (target paths + operation) to `.jasper/` before the loop, clear on completion; on startup, if a manifest is present, resume/complete or roll back. Lower-effort: make the operations idempotent and surface a "re-run to finish" affordance when partial state is detected.

---

## DUR-07 — No backup/version tooling; overwrites are unrecoverable

**Priority:** MEDIUM · **Executor:** sonnet (subcommand); opus (versioning) · **Effort:** M

### Evidence

The migration runner backs up the *derived* SQLite (it's regenerable) but the actual notes have only prose guidance ("copy your data directory somewhere safe"); `cmd/jasper/` has serve/install/uninstall/status/doctor/version only — no export/backup, no snapshotting, no version history. The irony is real: the regenerable index is auto-backed-up; the irreplaceable notes are not.

### Scenario

Combined with DUR-02 (silent overwrite) and no per-note history, a single bad save or clobbered sync is permanently lost.

### Fix

Ship `jasper backup [--to <dir>]` (timestamped tar/zip of the vault). For real safety, keep the last N versions of each note under `.jasper/versions/` on every write — cheap, local, and consistent with the soft-delete ethos, making overwrites reversible (this also softens DUR-02's blast radius).

---

## DUR-08 — Orphaned `*.tmp.*` files left on crash

**Priority:** LOW · **Executor:** sonnet · **Effort:** S

### Evidence

`atomic.go:32` creates `os.CreateTemp(dir, base+".tmp.*")`; cleanup runs on error paths, but a crash between `CreateTemp` and `os.Rename` orphans the temp file. Correctly ignored by the indexer (`walk.go:74`), but it lingers in `notes/` and a sync client replicates it everywhere.

### Fix

Sweep `notes/` for `*.tmp.*` older than a few minutes at startup and remove them.

---

## Verified sound (checked against code)

- **AtomicWrite** — all five steps present and correctly ordered (temp in same dir → write → fsync → rename → fsync parent), with cleanup on every pre-rename error path (`atomic.go:29-73`); `MoveFile`/`MoveDir`/`CreateDir` all fsync the parent. Crash between rename and parent-fsync is the normal atomic-rename durability window, acceptable.
- **Soft-delete** to `.trash/` with no-overwrite suffixing; MCP delete inherits it.
- **Reconcile robustness** — `filepath.WalkDir` (Lstat-based) can't follow symlink loops; read failures and case collisions are skip-and-continue; mid-walk disappearance handled. One rough edge (not a full finding): a non-collision `Upsert` error aborts the *entire* remaining walk (`reconcile.go:104`) and startup treats reconcile failure as non-fatal (`lifecycle.go:265`), so the app can serve a partial index with no retry — consider skip-and-continue on transient Upsert errors too.

---

## Verification & platform notes

- **DUR-04 is WSL-only and must be tested on a case-sensitive filesystem.** It passes vacuously on macOS (APFS is case- and normalization-insensitive), so its regression test belongs in Linux CI / the fake-WSL Docker harness (`make test-wsl-e2e`), not the Mac dev loop. This is the clearest example of a finding whose *test* has a platform requirement even though the *fix* is cross-platform.
- **DUR-01's watcher has platform nuance:** `fsnotify` maps to FSEvents (macOS) and inotify (Linux/WSL2); inotify does **not** fire for changes made on a Windows drive mounted into WSL (`/mnt/c`), only for edits within the Linux filesystem. If coworkers keep vaults on `/mnt/c`, the watcher won't see external edits there — document the limitation and keep the manual-reindex affordance as the fallback. Worth a line in discuss-phase.
- **DUR-01/02/05 are all cleanly testable at the Go integration layer** (write to `notesDir`, assert index/broadcast) — no browser needed, which sidesteps the E2E-harness friction noted in `06-security.md`.

# 01 — Data Integrity: the Save Path

The core promise of Jasper is that writing and finding notes is trustworthy. Three HIGH findings here are direct breaks in that promise, all on the interactive save path, all invisible in the existing test suite because tests either reindex before asserting or create their fixtures in-process.

---

## DI-01 — Interactive saves silently wipe FTS body content; reconcile can never heal it

**Priority:** HIGH · **Executor:** sonnet · **Effort:** M · *(claim re-verified against source)*

### Evidence

- `backend/internal/notes/service.go:167-175` — `Update` builds the index record with **no `BodyFTS` / `TagNamesFTS`**:
  ```go
  rec := NoteRecord{ ID: id, Path: relPath, Title: freshTitle,
      MTimeUnix: modTime.UTC().Unix(), SizeBytes: int64(len(content)),
      Checksum: "", UpdatedAtUnix: modTime.UTC().Unix() }
  ```
  Same in `createInternal` (`service.go:322-330`) and `Move` (`service.go:459-473`; `LookupByPath` in `index/store.go:148-150` doesn't SELECT `body_fts`).
- `backend/internal/index/store.go:66` — `Upsert` unconditionally overwrites: `body_fts = excluded.body_fts`.
- `backend/migrations/003_fts.sql:106-111` — the `AFTER UPDATE` trigger propagates the empty string into `notes_fts`.
- Self-heal paths do NOT catch it:
  - `backend/internal/index/reconcile.go:67-69` — incremental reconcile skips when `cur.MTime == fm.MTimeUnix`. `Update` stores the file's fresh mtime, so mtimes match and the file is **skipped forever**.
  - `backend/internal/index/fts.go:81-88` — divergence repair only fires when *all* rows have empty `body_fts` (`populated == 0`).
- Only `reconcile.go:95,152` ever populates `BodyFTS` — never the interactive path.

### Failure scenario

Edit any note → its body text disappears from Cmd+P full-text search and MCP `search_notes`, permanently, until a manual **full** reindex. Notes created via MCP `create_note` with a body are never body-searchable. Masked by the title/path-LIKE fallback (`store.go:416-430`).

### Fix

1. Move `ExtractBodyForFTS` / `JoinTagNamesForFTS` from `internal/index/fts.go` into `internal/markdown` (or a shared leaf package) so `notes` can use them without importing the adapter.
2. In `Service.Update` and `createInternal`, set `rec.BodyFTS = markdown.ExtractBodyForFTS(content)` and `rec.TagNamesFTS = strings.Join(canonical, " ")` — the content is already in hand.
3. In `Service.Move` / `Indexer.LookupByPath`, include `body_fts, tag_names_fts` in the SELECT so a moved row keeps its content.

### Done when

Regression test (write it first): update a note via `Service.Update` → `SearchFTS` for a body-only term must hit **without any reconcile**. Same for create and move.

---

## DI-02 — Registry title index is dead after every restart; backlink resolution silently broken

**Priority:** HIGH · **Executor:** sonnet · **Effort:** M · *(claim re-verified against source)*

### Evidence

- `backend/internal/notes/registry.go:134-143` — `Hydrate` rebuilds `byID` but **clears** the title map: `r.byTitle = make(map[string][]NoteRecord)`.
- `HydrateRecords` (`registry.go:152`) — the variant that populates `byTitle` — has **zero production callers** (grep: only referenced from registry.go's own comments). Its doc comment falsely claims "Called by the composition root at startup."
- `backend/internal/app/lifecycle.go:281-288` — boot calls `Registry().Hydrate(summaries)` then `ResolvePendingBacklinks(...)`, which resolves via `registry.FindByTitle` (`index/backlinks.go:268`) against the just-emptied map → resolves nothing, then logs success.
- `SyncBacklinks` on every save resolves via `FindByTitle` (`backlinks.go:62`); `byTitle` is only fed by `AddRecord` in `createInternal` (`service.go:339`). `Service.Update` never refreshes the title entry either.
- `api/admin_reindex_handler.go:27` uses the same title-erasing `Hydrate` after a full rebuild.

### Failure scenario

After any restart (or Path-2 rebuild), writing `[[Existing Note]]` produces a pending row (`target_id NULL`), which `GetBacklinks` excludes (`backlinks.go:117`). Backlinks only work for link targets created during the current process lifetime. E2E passes because tests create targets in-session.

### Fix

1. `Index.List` already returns `Title` in `NoteSummary`. Either change `Registry.Hydrate` to populate `byTitle` from summaries (via `titleKey`), or switch both call sites (`lifecycle.go:281`, `admin_reindex_handler.go:27`) to a `HydrateRecords`-shaped call. Prefer one hydrate function; delete the other to prevent recurrence.
2. Make `Service.Update` refresh the title entry via `AddRecord` with `freshTitle` (it already computes it) so H1 edits keep the index current.

### Done when

Test: simulate restart (fresh registry + hydrate from index) → save a note containing `[[target]]` → `GetBacklinks(target)` is non-empty. Second test: `ResolvePendingBacklinks` resolves a pre-seeded pending row after hydrate.

---

## DI-03 — Autosave, keepalive, and reconnect saves never send If-Match; optimistic locking is bypassed on the paths it was built for

**Priority:** HIGH · **Executor:** opus · **Effort:** M · *(found independently by two audit passes; re-verified against source)*

### Evidence

- `frontend/src/components/EditorPane.tsx:334` — the normal save path: `await updateNote(id, latestContent)` — no `ifMatch` argument. `frontend/src/lib/notesApi.ts:27-33` only sends the header when passed.
- `EditorPane.tsx:379-381` — on WS `connectionRestored`, pending edits are saved **unconditionally**: `if (userHasEdited.current ...) void performSave(latestContentRef.current)`.
- `EditorPane.tsx:483-509` — the `visibilitychange`/`beforeunload` keepalive PUTs are raw `fetch` with no `If-Match` at all.
- The only sender is the conflict banner's "Save anyway" button (`EditorPane.tsx:655-658`) — which only appears if a WS `note:updated` event was *received*.
- Server side is permissive by design: `backend/internal/notes/service.go:141` — `if ifMatch != "" { ... }`.
- The client already tracks what it needs: `saveStateMachine.ts:27,45` carries `updatedAt` from every save response; it's just never used as a precondition.

### Failure scenario

Conflict detection currently depends 100% on WS delivery — exactly the channel that fails in the conflict scenario. Concretely: tab B's WS drops (laptop sleep, or slow-client drop at `wshub/hub.go:122-127`). Tab A saves the note. Tab B reconnects holding stale edits → `connectionRestored` fires an unconditional PUT before any event could arrive (events during the gap are gone — see SY-02) → A's write is silently destroyed. Same for closing a tab with stale edits (keepalive PUT). The entire SYNC-06 machinery (StaleWriteError schema, banner, server comparator) is bypassed.

### Fix

Thread the known server version through every save. Do FE-07 (extract `useNoteSave`) first or together — it's the enabler.

1. Store `lastKnownUpdatedAt` in the save machine's context: seed from `GET /notes/{id}` on load (`data.updated_at`), update from every PUT response and every accepted `note:updated` event.
2. `performSave` always calls `updateNote(id, content, lastKnownUpdatedAt)`. The keepalive fetch sets the same `If-Match` header (raw fetch can carry headers; collapse the two duplicated keepalive blocks into one helper while there).
3. On `409 stale_write`, dispatch a new `saveConflicted` event into `saveStateMachine` and surface the existing conflict banner (`setConflictBanner` with `current_updated_at` from the error body — the handling at `EditorPane.tsx:661-676` already exists).
4. On the reconnect path, refetch the note first and compare `updated_at` before deciding to push or show the banner.

**Care point for the implementer:** the server's frontmatter rewriteback (`service.go:200-212`) changes the file mtime *after* the response comparator is computed — verify the returned `updated_at` matches what the next If-Match will be compared against, or the first autosave after every load will 409. This interaction is why this is opus-tier.

### Done when

Two-session E2E: session A and B open the same note; kill B's WS; A saves; B reconnects with local edits → B gets the conflict banner, A's content is intact on disk. Plus a unit test that every `performSave` call site sends If-Match.

---

## DI-04 — If-Match is check-then-act with no serialization, and `updated_at` is two incompatible clocks

**Priority:** MEDIUM · **Executor:** opus · **Effort:** M

### Evidence

- **TOCTOU:** `service.go:141-160` — `Stat` → compare tag → `WriteAtomic`, no per-note lock anywhere in `Service`. REST (:6683) and MCP (:6684) are independent listeners; two concurrent PUTs carrying the same valid If-Match both pass the check, one silently wins. The bulk rewrites (`RenameTagAcrossVault`, `service.go:737-749`) have the same read-modify-write race against concurrent saves.
- **Two clocks:** If-Match compares RFC3339**Nano** file mtime (`service.go:147`), but index-backed responses truncate to seconds: `index/store.go:128`, `index/tags.go:151`, `index/backlinks.go:183` (`time.Unix(mtime, 0)`), `daily.go:140`. So `updated_at` from `/tree`, note lists, tag lists, backlinks, or an existing daily note can **never** be a valid If-Match comparator — guaranteed spurious `stale_write` for any client that reasonably seeds from those.
- **Fabricated timestamps:** `api/notes_handlers.go:194,208` — `PostNoteMove` returns `UpdatedAt: time.Now().UTC()` on rollback/zero-value paths — a timestamp matching no file mtime.

### Fix

1. **One canonical version.** Best: an explicit opaque `etag` field (and `ETag` header) on `Note`/`NoteSummary`, spec'd as "the only legal If-Match value," backed by nanosecond mtime stored in the index (`UpdatedAtUnixNano`). Minimum: make every emission nanosecond-precision so all `updated_at` values are comparator-valid.
2. Add a keyed mutex to `Service` (`sync.Map` of per-note-UUID `*sync.Mutex`, or — given single-user scale — one `writeMu` covering the Stat→WriteAtomic window in `Update`, also taken by the bulk-rewrite FS pass).
3. Delete the fabricated timestamps in `PostNoteMove` (fixed naturally if SY-03 moves that orchestration into the service).

### Done when

Concurrent-PUT test (same If-Match, two goroutines) asserts exactly one 200 and one 409. A test asserts `updated_at` from `GET /tree` round-trips as a valid If-Match.

---

## DI-05 — Migration `StateRolledBack` boots new code on an old schema

**Priority:** MEDIUM · **Executor:** opus · **Effort:** M

### Evidence

- `backend/internal/db/migrate/runner.go:153-209` — on migration failure + successful backup restore, `Run` returns `(StateRolledBack, nil)`; doc comment (lines 111-113): "the app keeps running on the prior schema."
- `backend/internal/app/lifecycle.go:219-269` treats this as success: proceeds to scaffold, seed grants, reconcile, full API wiring.
- But the binary that shipped migration N+1 also ships indexer/handler code written against schema N+1 — a query touching the new column now errors **at request time** in production, with no banner beyond generic UX-03.

On the "is the backup machinery overengineered?" question: no — `RebuildAndReindex` (Path 3, `runner.go:385-444`) makes SQLite regenerable, but the backup buys fast startup on rollback without a full-vault rescan, which is real at 5k notes. The risky half is only the *rolled-back-and-keep-serving* semantic. The safe degraded state for a derived index is "rebuild it," not "serve on stale schema."

### Fix

On `StateRolledBack`, automatically attempt the rebuild path (`RebuildAndReindex`) at boot rather than serving on the prior schema; only if that also fails go unrecoverable. This collapses a runtime-failure class into the already-handled boot-failure class and makes the three paths a strict ladder: apply → rebuild → give up. The 2× disk-headroom preflight (`runner.go:220-241`) can then relax to `size + slack`.

### Done when

`runner_test.go` exercises: failing migration → backup restored → rebuild attempted → app serves on the **new** schema. And: failing migration + failing rebuild → unrecoverable page.

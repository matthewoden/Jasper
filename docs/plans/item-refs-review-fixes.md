# Item refs — review fixes

Written 2026-10-05, from the two-axis review of `main...feat/item-refs` (standards + spec, with [universal-item-references.md](./universal-item-references.md) as the spec). Every finding below was checked against the code at `864dd1b`. This plan replaces filing tickets: work it top to bottom on `feat/item-refs`, one commit per item, TDD (failing test first) for every behaviour change.

Parts A and B gate the merge. Part C is cleanup that may land before or after it.

## Decisions (owner, 2026-10-05)

- `make compose-check` gets its own CI job (C6). It stays out of lefthook.
- JASPER-47: CRLF frontmatter is **normalised to LF on save**, so the `id` line lands. That's implemented in the JASPER-47 fix after the merge, not here. It's recorded here because it removes the `ErrCRLFFrontmatter` skip paths in A1 and A2 later.

## Part A — data integrity (must land before merge)

### A1. The upgrade id walk writes into `attachments/`

`InjectNoteIDs` (`backend/internal/app/noteid_migration.go:46-62`) skips dot directories but not `attachments/`. `index.WalkVault` (`index/walk.go:52`) skips both. So any `.md` file inside an `attachments/` folder gets an `id` line on upgrade and a doctor warning, but it is never indexed as a note. That breaks spec §10 #15: "real run writes only the `id` line".

**Fix:** drive the walk with `index.WalkVault` instead of a private `filepath.WalkDir`. The two walks then define "a note" the same way, and the duplicated dot-skip/`.md` filter goes away (standards finding). `WalkVault` yields `FileMeta` with `AbsPath` and `CanonicalRelPath`. The scratchpad check keeps comparing the lowercased rel path. `app` already imports `index`, so this adds no dependency edge.

**Test:** in `noteid_migration_test.go`, a vault with `attachments/readme.md` and `sub/attachments/x.md`. Both files must be byte-identical after a real run and absent from `report.Written`.

### A2. Reconcile can overwrite a concurrent save

`ReconcileWithRegistry` reads each file during the walk (`index/reconcile.go:88`). Much later it calls `writeID` (`:120` → `:246`), which runs `fsstore.AtomicWrite(c.content + id)` with no lock and no re-check. Reconcile also runs from the live admin reindex (`api/admin_reindex_handler.go:109`). If a save lands between the read and the write, the save is silently replaced with the older content.

**Fix:** a compare-before-write guard in `writeID`:
1. Re-read the file immediately before writing.
2. If the bytes differ from `c.content`, don't write. A save got there first, so take its content: `c.content = fresh`. If `markdown.ReadID(fresh)` now yields a valid id, adopt it (`c.id = that`, and skip the write). Otherwise write `WithID(fresh)` instead.
3. Log at Info when the guard fires.

This shrinks the race window from the whole walk to a read and a rename. Closing it fully would need reconcile to take the service's per-note lock, but the lock is keyed by id and this file has none yet. That's a cross-package seam for a window of microseconds; not worth it now. Say so in one line in the `writeID` doc comment.

**Test:** `reconcile_id_test.go`, a seam to rewrite the file between walk and write. Add an unexported `afterWalk func()` hook on `Indexer`, set only in tests. The test overwrites an id-less file inside the hook with new content that carries an id, then runs reconcile. Assert that the file's content is the hook's content and that the indexed id is the hook's id. Add a second case where the hook writes new content with no id: the result is that content plus one minted id.

### A3. `CreateWithID` accepts a tombstoned id and races with itself

`CreateWithID` (`notes/service.go:269-274`) checks only `s.registry.Lookup(id)`. A tombstoned id passes, and `Upsert` then deletes its tombstone (`index/store.go:42`). Every reference to the deleted note silently starts naming the new one. The check and the create are also unlocked, so two concurrent MCP `create_note` calls with the same id both succeed and leave two files carrying one id. That breaks spec 1.3: "rejected if malformed or already taken".

**Fix:**
- Take `s.writeLocks.lock(id)` for the whole of `CreateWithID`.
- Under the lock, reject when the registry has the id **or** `s.index.LookupItem(ctx, id.String())` returns `Status == ItemStatusDeleted`. Both cases return `ErrIDTaken`.
- `createInternal` adds to the registry (`service.go:341`) before returning, so holding the lock across it covers check-then-insert.

**Tests (service_test.go):** (1) delete a note, then `CreateWithID` with its id returns `ErrIDTaken`. (2) Run 8 goroutines of `CreateWithID` with the same id and different titles: exactly one succeeds, and exactly one file on disk carries the id. Run (2) with `-count=50 -race` before committing.

### A4. `GET /blobs/{id}` serves a path without checking it still holds the bytes

`GetBlob` (`api/items_search_handler.go:64-99`) serves `blob.Paths[0]` unchecked. After an in-place edit, and before the next reconcile, the old id serves the new bytes. When `Paths[0]` is gone but `Paths[1]` holds the bytes, it returns 404. That breaks spec 2.7: "streams the first live path".

**Fix:**
- In `GetBlob`, walk `blob.Paths` in order. Read each file, hash it, and serve the first whose digest equals `blob.SHA256`.
- If no path matches, return 404.
- Hashing is bounded by the attachment size limit, so there's no streaming concern for now.

**Tests (items_search_handler_test.go):** (1) Overwrite the file after indexing: the old id returns 404. (2) Two paths with the same bytes; delete the first: the second is served.

### A5. `replaceRefInDoc` rewrites longer refs that share a prefix

`replaceRefInDoc` (`frontend/src/editor/refChip.ts:61-70`) uses a bare `indexOf`. Blob ids are a 16-hex prefix that gets re-keyed to the full digest on collision (`index/blobs.go:180-181`). So `jasper:blob/sha256-<16hex>` is a real prefix of `jasper:blob/sha256-<64hex>`, and the one-click fix corrupts the longer ref.

**Fix:** only replace an occurrence whose next character is `]` or `|`. Those are the only characters that can end a ref target inside `[[…]]`.

**Test (refChip.test.ts):** a doc holding both `[[jasper:blob/sha256-aaaa]]` and `[[jasper:blob/sha256-aaaabbbb]]`. Replacing the first leaves the second untouched.

## Part B — spec gaps (land before merge)

### B1. Reference changes from reconcile and Create never reach the event stream

Spec 2.3: "Emit it after the save (file-first order) and from reconcile." Only `Update` broadcasts `EventRefsChanged` (`notes/service.go:215-232`). `createInternal` discards the delta (`:360`), and so does reconcile's `syncDerivedDataWithTags` (`index/reconcile.go:285`). So GraphQL `itemChanged` never reports references from new notes or from edits made outside Jasper.

**Fix:**
- **Create:** broadcast `EventRefsChanged` from the delta, with the same payload and file-first order as `Update`. Pull the existing Update block into a small `s.broadcastRefsDelta(ctx, id, delta)` that both call.
- **Reconcile:** the indexer has no broadcaster, and shouldn't get one (it's a leaf of `notes`). `ReconcileWithRegistry` collects the non-empty deltas into a `[]notes.RefsDeltaFor{ID, Delta}` on its result. The callers broadcast them: the two lifecycle call sites and the admin handler. Reconcile then returns a small result struct (`n`, deltas) instead of `int`. Update the call sites listed under `grep -n "Reconcile" backend/internal/app/lifecycle.go backend/internal/api/admin_reindex_handler.go`.
- Broadcasts from reconcile carry no origin session, so every client hears them.

**Tests:** service test: a note created with a ref broadcasts one `refs.changed` naming it. Reconcile test: write a file containing a ref directly to disk, reconcile, and the result carries its delta. Admin-handler test: the delta is broadcast.

### B2. `id` isn't shown read-only in the editor

Spec N5: "The frontmatter decoration and the Properties view show `id` read-only." The server forces the id on save, so nothing is lost today, but editing the line produces a confusing rewrite.

**Fix:**
- In the frontmatter decoration, mark the `id:` line read-only with a `EditorState.changeFilter` that rejects changes intersecting that line's range. Deleting the whole frontmatter block is still allowed; the server re-adds the id.
- Give the line a muted style.
- In the Properties view, render `id` as non-editable text, with a copy button if the view already has one for other fields.

**Tests:** vitest: a transaction editing inside the `id:` line is filtered out; an edit on the next line passes. One Playwright assertion that the Properties `id` field has no input.

### B3. The criterion 3 test doesn't cover blob ids

Criterion 3: "restores every note id and blob id". `TestReconcile_RebuildRestoresIDs` (`index/reconcile_id_test.go:78`) asserts note ids only.

**Fix:** extend it with two attachments, one of which shares bytes with nothing. After wipe and rebuild, both blob ids are equal to their pre-wipe ids.

### B4. The `@` picker embeds non-image blobs

`mentionInsertion` (`frontend/src/editor/mentionAutocomplete.ts:38-41`) always inserts `![[…]]` for a blob. The upload flow inserts `[[…]]` for non-images.

**Fix:** use `isImageName(hit.title)` from `blobEmbedPlugin.ts`, which is already used for embeds. Images get `![[…]]`; anything else gets `[[…]]`.

**Test:** a `.png` hit gets the bang and a `.pdf` hit doesn't.

### B5. A test writes into the source tree, and its output is committed

`items_search_handler_test.go:37,130` resolves `srv.notesRoot()` relative to the package directory. It wrote `backend/internal/api/notes/attachments/{roadmap,shot}.png`, and those files were committed.

**Fix:** give the test server a `t.TempDir()` notes root, as the other handler tests do, then `git rm` the two PNGs. Afterwards, run `go test ./internal/api/` and check that `git status` is clean.

## Part C — structure (before or after merge)

### C1. One `Ref` type, one parser

Four places parse a reference's prefix with a string `switch`:
- `graphql/resolver.go:27-43` (`canonicalRef`)
- `mcp/tools.go:628-641`
- `notes/service.go:1074-1089`
- `index/items.go:52-61`

Three of them hardcode `"sha256-"`.

**Fix:**
- Add `notes.ParseItemRef(s string) (ItemRef, error)` to `notes/ports.go`, next to `RefForNote` / `RefForBlob`. `ItemRef` is `{Namespace, Kind, ID string}` with `String()`. It accepts the bare and the `jasper:`-prefixed forms.
- Move `BlobIDPrefix` into `notes` and export it, and have `index` use it.
- Replace the four switches with calls to the parser.
- Make `ItemInfo.Kind` and `Status` named string types (`ItemKind`, `ItemStatus`) using the existing constants.

This is a pure refactor under the existing tests; add only a table test for `ParseItemRef`.

### C2. The `/graphql` wiring is duplicated between boot and vault swap

`app/lifecycle.go:292,340` and `:499,532` each build `graphql.NewEvents` and mount `/graphql`. Pull both into one `a.mountGraphQL(router, indexer, svc)` helper, called from both paths. The existing swap E2E covers it.

### C3. Casts from the index port to the concrete type

There are four new `s.index.(*index.Indexer)` assertions:
- `api/items_search_handler.go:50,69`
- `api/note_refs_handler.go:20`
- `api/attachments.go:107`

`graphql.Resolver.Blobs` also takes the concrete indexer. Add the methods they need (`SearchItems`, `GetBlob`, `NoteRefs`) to a narrow `api.itemsIndex` interface, defined in `api` where it's consumed. `*index.Indexer` satisfies it. The server holds that interface and the casts go. Don't widen `notes.Index` for read-only API needs.

### C4. Repeated literal

`api/refs_handler.go:43` hardcodes "at most 200" beside `itemsBatchMax`. Format the message from the constant.

### C5. Record the client-side reference grammar in ADR-0023

`refChip.ts` reimplements the grammar from `markdown/refs.go` (`isRefTarget`, `parseRef`), and `itemsApi.ts:139` splits the namespace a second time. ADR-0023 says never to duplicate a content transform in TypeScript.

**Fix:** add a dated amendment. The editor must recognise references synchronously to draw chips, and `replaceRefInDoc` is a user edit that goes through the normal etag check, so neither counts as a server transform. Point `itemsApi.ts` at `parseRef` so the TS side has one parser.

Also add a short "Note on precedent" to the ADR that owns `schema_migrations`, or to CONVENTIONS. Both one-time file migrations (`frontmatter_migration.go`, `noteid_migration.go`) read and write their marker rows from `app`. The review flagged this against CLAUDE.md's "Direct SQLite Queries Outside Index Package", but it predates this branch. Either move both behind a `migrate.Marker(ctx, db, name)` / `migrate.RecordMarker(...)` pair or accept the precedent in writing. Recommendation: move both. It's two small functions and it removes the exception.

### C6. CI job for compose-check

Add a `compose-check` job to `.github/workflows/ci.yml`:
- `ubuntu-latest`
- `actions/setup-node` with `node-version-file: .nvmrc`
- an `actions/cache` step on `${{ runner.temp }}/jasper-compose-check`
- `TMPDIR: ${{ runner.temp }}`, then `make compose-check`

It has no dependency on the other jobs. Check it with a push to the branch once the owner approves pushing.

### C7. GraphQL introspection

`graphql/handler.go:31` turns introspection on. Federation composition reads the SDL from `api/graphql`, not from introspection, so nothing needs it. Turn it off; it isn't needed on a server that should stay quiet. There is no dev-mode flag to gate it on, so it is simply removed.

## Not acting on

- Lefthook now runs serially, and `perf-check.sh` gained `--vault`/`--bind`. Both were deliberate fixes made during implementation.
- `GET /notes/{id}/refs` and `GET /items/search` weren't in the spec. The picker and the backlinks panel use them, so they stay.
- `WithID` edits YAML line by line instead of through a node API. The byte-preservation guarantee requires that, so it stays. JASPER-50 consolidates the fence scanning.
- `graphql/events.go:65` reads event payloads from `map[string]any` by key. That's how every broadcaster consumer reads payloads today, so it isn't worth changing alone.

## Done when

- Parts A and B are committed. Lint, `make gen-check`, `go test -race ./...`, vitest, and the full Playwright suite (after `make build`) are green, and `make perf-check` passes at 5k.
- A3's concurrency test passes under `-count=50 -race`.
- `git status` is clean after the backend tests (B5).
- Then ask the owner to merge `feat/item-refs` into `main` (a local merge commit) and whether to push. After that comes Step 2 of the handoff (JASPER-50 → 48 → 49 → 47).

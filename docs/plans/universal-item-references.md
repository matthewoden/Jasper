# Universal item references — implementation plan

**Status:** Draft, 2026-10-04
**Source:** "Jasper: Universal Item References — Agent Handoff" (Oct 4, 2026). It is referred to below as *the spec*. This document amends it where the codebase or the owner's decisions require.

This plan is the spec checked against the code as it stands at `d9017e9`. It records the decisions taken so far, answers the spec's open questions, raises the new ones the investigation turned up, and breaks phases 1–3 into weekend-sized stories. Phase 4 stays deferred.

---

## 1. Decisions taken (2026-10-04)

| Topic | Decision | Departs from spec? |
|---|---|---|
| Note id format | **ULID, per spec.** Existing UUIDs are not carried forward. | No |
| GraphQL `body` gate | **No gate.** `body` is readable for every note, matching MCP, where reads are global ([ADR-0013](../adr/0013-mcp-always-on-grant-gated.md), `mcp/acl.go:3`). | **Yes.** The spec's "AI read access" ACL does not exist, and we are not adding one. Acceptance criterion 10 is dropped. |
| Attachment embeds | **Id embeds, per spec.** New uploads insert `![[jasper:blob/sha256-…\|name.png]]`. | No, but it reverses ADR-0034's rationale (§3) |
| Planning artifact | This document, in the repo. | — |

---

## 2. What the code looks like today

These findings change the shape of the work. File references are as of `d9017e9`.

### Identity

- **Note ids are random UUID v4s minted by the indexer** (`index/indexer.go:65-73`, `chooseID`). They are stored only in `notes.id`. A full reindex (`reconcile.go:155`, `chooseID(uuid.Nil, …)`) or a deleted `app.db` re-mints every id. A rename made outside the app becomes a delete plus a new id. [ADR-0032](../adr/0032-bookmarks-carry-a-path-recovery-hint.md) exists because of this.
- **Note `Create` writes the file without an id** and only then mints one (`notes/service.go:285,294`).
- **`uuid.UUID` is the note-id type throughout the backend.** That covers roughly 40 call sites, including the registry map key (`registry.go:43`), `keyedMutex` (`keyedmutex.go:21`), every service signature, `index/tags.go`, `index/backlinks.go`, the MCP validators (`mcp/tools.go:370,471-476`, `adapters.go:76`), bookmarks (`bookmarks/load.go:57-61`, `service.go:79`, `api/bookmarks_handler.go:276-296`) and the attachments handler (`api/attachments.go:217`).
- **`api/openapi.yaml` declares note ids `format: uuid` at about 25 sites**, 31 counting bookmark and session ids. `oapi-codegen` binds them as `openapi_types.UUID`, so a non-UUID path parameter gets a 400 before any handler runs.
- **The frontend treats ids as opaque strings.** No regex, no length check, no sorting. The only shape-dependent value is `ScratchpadUUID` (`notes/registry.go:15`, `frontend/src/lib/notesApi.ts:18`).
- **Upsert is keyed on id** (`index/store.go:43-60`, `ON CONFLICT(id) DO UPDATE SET path=…`). Once ids live in frontmatter, two copies of a note share an id, and this statement would silently move the row to whichever copy was processed last.

### Frontmatter

- **Both frontmatter writers re-serialize the whole block.** `markdown.RewriteFrontmatterTags` (`markdown/tags.go:161-243`) and `notes.rewriteTagsArray` (`notes/rewriter.go:16-85`) go through `yaml.v3` `Node` → `Marshal`. Key order and comments mostly survive. Indentation is normalized to 4 spaces, quoting is not preserved, and `tags` is forced into flow style. **No test asserts byte preservation.**
- **Fences are found in three different places.** `extractFrontmatterRange`, `stripFrontmatterBlock` and `RewriteFrontmatterTags` each scan with `bytes.Index(rest, "\n---")`. That diverges from the strict `HasFrontmatter` contract, because `\n---` also matches a `----` line.
- **CRLF frontmatter is outside the contract** (`markdown/frontmatter.go:14`). Because Update prepends a scaffold whenever `!HasFrontmatter` (`service.go:139`), a CRLF note gets a second, LF frontmatter block on save. This bug predates the work.
- **The repo already has a one-time file-rewriting migration**: `app/frontmatter_migration.go`, which scaffolds frontmatter into every note. Its marker row lives in `schema_migrations`. A full rebuild drops that table, so the walk re-runs, which is safe only because each file is handled idempotently. Nearly every existing note already has a frontmatter block as a result.

### Links, attachments, search, MCP, sync

- **Wiki-links are resolved by title only** ([ADR-0010](../adr/0010-title-only-wiki-links.md)). Today `[[ado:workitem/12345]]` is a pending link titled `ado:workitem/12345`, and Cmd-clicking it fails with a 400 because `validateBareName` rejects `/`. **No valid note title can contain `/`**, so a target that matches the ref grammar can never be mistaken for a title.
- **The goldmark `wikilink` parser splits on the last `#`** and keeps it as a fragment. The parser keeps the `\|` alias and the embed flag, but Jasper's `ExtractWikilinks` throws both away (`markdown/wikilinks.go:20-23`).
- **`SyncBacklinks` replaces a source's links in one transaction:** `BEGIN IMMEDIATE`, then `DELETE WHERE source_id`, then the inserts (`index/backlinks.go:31-112`). The new `refs` table can share that transaction.
- **Attachments are not indexed at all.** `WalkVault` skips `attachments/` (`index/walk.go:52`). Nothing is hashed, and the only `checksum_sha256` column, on `notes`, is always empty. The tree does list every non-`.md` file (`index/tree.go:255-310`). Uploads write `![name](attachments/<percent-encoded>)` ([ADR-0035](../adr/0035-attachment-references-are-percent-encoded.md)). When a note changes folder, its attachments move with it ([ADR-0034](../adr/0034-attachments-travel-with-the-note.md)).
- **MCP has no read tier.** Reads are global, and grants gate writes only, at tier 1 (create and update) or tier 2 (adds move and delete).
- **WebSocket events use colon names** (`note:updated`, `links:rewritten`). The full set is enumerated in `openapi.yaml:2848-2891`. On the frontend, `useSessionSync.ts` hands events to `lib/resources` for invalidation.
- **The editor renders wiki-links in `wikilinkPlugin.ts`**, using a regex `MatchDecorator` and a title→id snapshot. It is not a lezer node and not part of `livePreviewPlugin`. `@` is not bound to anything. `fileChipWidget.ts` is an existing chip widget we can reuse.
- **The perf gate is `make perf-check`**, which requires cold start under 5 s on a vault of 5,000 notes with almost no links. Nothing measures links or refs at volume, and nothing measures hashing.

### GraphQL library

- **gqlgen is the only Go library with federation v2 support.** It supports entity interfaces (`interface X @key`; see its `plugin/federation/testdata/entityinterfaces` fixture) and `@interfaceObject`. It contains no CGo.
- **Pin it at v0.17.94.** v0.17.95 (2026-09-01) requires Go 1.26.
- **Since v0.17.92 its websocket transport uses `coder/websocket`.** It supports `graphql-transport-ws`, legacy `graphql-ws` and SSE. It needs `coder/websocket` v1.8.15, a patch bump from our v1.8.14, and adds no second websocket library.
- **The codegen tool can be a `tool` directive in `go.mod`**, alongside air and lefthook.
- **Federation docs don't cover entity interfaces.** The test fixtures are the only reference.

---

## 3. ADR conflicts

Each of these is reversed or extended deliberately. Following the ADR README, **amend the existing ADR in the same change that implements the reversal.** Don't mint a new number for a topic that already has one.

| ADR | Conflict | Action |
|---|---|---|
| [0032](../adr/0032-bookmarks-carry-a-path-recovery-hint.md) | **Explicitly rejected `id:` in frontmatter.** It gave three reasons: it writes Jasper's bookkeeping into every user file, Obsidian doesn't do it, and the reset dialog promises "your `.md` files are not touched". | Amend in phase 1 to record the reversal and its new reason (federated identity needs ids that survive a rebuild). The path hint can stay as belt-and-braces. The reset dialog's promise remains true for a *rebuild*: ids come back from frontmatter, and nothing is written. The *upgrade* is the one bulk write. |
| [0012](../adr/0012-incremental-reindex-on-startup.md) | Its consequence "a note restored from trash is re-adopted with a fresh UUID" stops being true. | Amend in phase 1. A restored note keeps its id, and its tombstone is cleared. |
| [0034](../adr/0034-attachments-travel-with-the-note.md) | **It rejected name-resolved embeds because they only render inside Jasper.** `![[jasper:blob/…\|x.png]]` has the same property: it renders nowhere else. Obsidian shows a broken embed, GitHub shows literal text. ADR-0034 calls portability "the product". | Amend in phase 2 to record the reversal, its cost (new uploads are no longer portable), and why identity was judged worth it. Existing path embeds and the move/copy relocation logic stay as they are. See open question N3 for a mitigation. |
| [0010](../adr/0010-title-only-wiki-links.md) | Adds a second link form, `[[ns:kind/id]]`. Path syntax stays unsupported. | Amend in phase 2: refs are a distinct grammar, and they can't collide with titles because titles can't contain `/`. |
| [0006](../adr/0006-openapi-as-the-bilateral-contract.md) | Adds a second contract, the GraphQL SDL, for external consumers. | Amend in phase 3. OpenAPI stays the frontend contract, and the SDL is the federation contract. Both are generated and drift-checked by `make gen-check`. |
| [0019](../adr/0019-obsidian-as-default-ux-reference.md) | Obsidian doesn't write ids into files. | Record this as a known divergence in the 0032 amendment. |
| [0027](../adr/0027-rendering-and-network-security-boundary.md) | In phase 4 the browser would call `gateway.url`, a different origin, which CSP `connect-src 'self'` blocks. | Phase 4 needs an explicit amendment. Prefer **proxying the gateway through the Jasper server** over widening `connect-src`. |

`CONTEXT.md` also needs glossary updates in phase 1: **Note** (identity is a ULID in frontmatter), **Registry** (ULID ↔ path), and new entries for **Ref**, **Blob** and **Tombstone**.

---

## 4. The spec's open questions, answered

1. **Carry today's index ids forward?** No. Today's ids are UUIDs, and the decision is ULID. They also aren't durable, so carrying them forward wouldn't preserve anything that a rebuild hasn't already broken. Here is what happens to each consumer on upgrade:
   - **Bookmarks** recover automatically through the ADR-0032 path hint. `bookmarks/load.go:57-61` currently drops any row whose id fails `uuid.Parse` *before* it tries path recovery, so the id validator has to change first (story 1.1).
   - **Persisted tabs, active note and switcher recency** (localStorage) are reset. That's acceptable under [ADR-0024](../adr/0024-pre-launch-no-migration-burden.md).
   - **Deep links holding old UUIDs** land on `/note-not-found`.
2. **Does the frontmatter library round-trip?** Not faithfully. `yaml.v3` `Marshal` normalizes indentation and quoting. **Use a targeted single-line insert:** `id: <ulid>` becomes the first line after the opening `---\n`. Never re-serialize. The existing tag rewriter re-serializes on any tag change. That is out of scope here, but the plan relies on it preserving keys, so an `id` line survives it, and story 1.2 adds a test for exactly that.
3. **Rewrite existing path embeds to ids during migration?** No, only new uploads. The migration writes the `id` line and nothing else (acceptance criterion 15).
4. **GraphQL library?** gqlgen **v0.17.94**, for the reasons in §2. Verify `go build` with `CGO_ENABLED=0` and the binary size delta in story 3.1.
5. **Should `searchItems` include blob file names?** Yes, both notes and blobs. This needs the blob index from story 1.6.
6. **Separate GraphQL port?** No. Share 6683 under `/graphql`, behind `csrfOriginMiddleware` (`app/app.go:200`) like every other route. Disable GraphQL over GET so a cross-site `<img>` or link can't trigger a query.
7. **Gateway rejects a request?** Phase 4. Fall back the same way as a timeout, and show a dismissible banner. Note the CSP conflict in §3.

---

## 5. New open questions

The investigation turned these up. Each has a recommended default, which the plan assumes unless overridden.

**N1. Who owns the `Item` entity interface?** *(Blocks phase 3's composition test.)*
In Apollo Federation 2.3, an interface carrying `@key` may be declared as an entity interface in **one** subgraph only. That subgraph must define *every* implementing type, and other subgraphs contribute fields through `type Item @key(fields: "id") @interfaceObject`. If the planner and BusyTown each also declare `interface Item @key`, composition fails. The spec's line that "the gateway's entity resolution overrides `ForeignRef`" doesn't match how entity resolution works either: a type is resolved by the subgraphs that define it, not overridden across names.
*Recommendation:* settle ownership before story 3.4. Two options fit. (a) One subgraph owns `Item` and every concrete type, and the rest use `@interfaceObject`. (b) `Item` is a value interface (`@shareable`, no `@key`) that each subgraph implements on its own entity types, with cross-system lookup done through `Query.item(id)` routed by namespace. Option (b) fits "each system owns its own types". Phase 3 builds against a local stub of whichever is chosen. *Confidence: high on the composition rule, but verify it against `@apollo/composition` in the story 3.4 spike before building on it.*

**N2. The spec's phase 3 says "read and write Jasper by id", but the SDL has no `Mutation` type.**
*Recommendation:* keep phase 3 read-only plus subscription. Writes go through REST (frontend) and MCP (agents), both of which accept the new ids. Add mutations only when a consumer needs them.

**N3. Should id embeds also carry a portable fallback?**
Here is an option that keeps the chosen id embed and softens the ADR-0034 cost: insert `![[jasper:blob/sha256-…|x.png]]` followed by an HTML comment or a hidden reference holding the path. Every option along these lines is clutter in the source, though.
*Recommendation:* no. Accept the cost as decided and record it in the 0034 amendment. Raised only so the trade-off is on the record.

**N4. Auto-rewriting replaced-blob embeds "only for folders with AI write access" couples MCP grants to the indexer.**
Grants authorize the *agent*, not Jasper's own reconcile. Jasper also never edits attachments itself, so an in-place edit is only ever noticed by reconcile, at startup or on refresh.
*Recommendation:* don't auto-rewrite. Record `replaced_by` on the tombstone, render the embed as *replaced*, and make the one-click fix a normal `Update` from the editor (file-first, etag-checked). Drop the grant condition.

**N5. Can a user edit or delete a note's `id` line?**
*Recommendation:* **ids belong to the server.**
- On every `Update`, the service forces the note's known id back into the content, re-inserting it if missing and restoring it if changed. Clients learn about this the same way they learn about a server-side tag rewrite today.
- The frontmatter decoration and the Properties view show `id` read-only.
- An *external* edit that changes the id, picked up by reconcile, is honoured as the source of truth: the old id is tombstoned and the new one adopted, unless the new id is a duplicate (see 1.4).

**N6. Duplicate-id tie-break.**
The spec says the older mtime keeps the id. But Finder's Duplicate and `cp -p` preserve mtime, so ties are common.
*Recommendation:* the path already indexed under that id keeps it. On a full rebuild, where no prior state exists, earlier birthtime wins, then the lexically smaller canonical path.

**N7. CRLF notes.**
*Recommendation:* don't insert an id into a file whose frontmatter is CRLF. Log it, report it in `jasper doctor`, and index the note under a session-only id that is never persisted. File the existing double-prepend bug separately rather than widening this work.

**N8. `file:` refs don't match the spec's grammar.**
`^[a-z]+:[a-z]+/.+$` requires a kind, and `file:/home/x.pdf` has none.
*Recommendation:* special-case the `file:` prefix in the grammar.

**N9. Characters allowed in a native id.**
A native id can't contain `]`, `|` or a newline, or the wiki-link breaks. `#` is split off as a fragment by the parser.
*Recommendation:* for ref targets, rejoin target and fragment (`Target + "#" + Fragment`). Document that `]` and `|` are unrepresentable, and percent-encode them in the picker if a foreign system ever produces them.

**N10. Event name.**
The spec says `refs.changed`. Existing events use colons.
*Recommendation:* name it `refs:changed`.

**N11. `items` table vs the existing `notes` table.**
A literal `items` table would duplicate `notes`.
*Recommendation:* add `blobs` and `blob_paths` tables, and make `items` a SQL **view** over `notes` and `blobs`. This keeps the spec's "additive only" property without two sources for note metadata.

**N12. `refs` vs the existing `backlinks` table.**
Both hold title-link resolutions.
*Recommendation:* fill both from one AST walk, in one transaction, in phase 2. The linked-mentions panel keeps reading `backlinks`, which holds its excerpts. Foreign and id backlinks come from `refs`. Fold `backlinks` into `refs` as a follow-up once phase 2 has settled.

---

## 6. Phase 1 — Identity

**Done when:** a rebuild from `notes/` restores every note id and blob id.

### 1.1 `notes.ID` type and ULID minting
- Introduce `type ID string` in `internal/notes` with `NewID()` (built on `github.com/oklog/ulid/v2`, pure Go with no dependencies; monotonic entropy) and `ParseID()` (26-character Crockford base32).
- Replace `uuid.UUID` for **note** ids across `notes`, `index`, `registry`, `keyedMutex`, `api`, `mcp` and `bookmarks`. Bookmark, folder and session ids stay UUIDs.
- In `openapi.yaml`, change every note-id site from `format: uuid` to `type: string, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$'`, then `make gen`.
- Replace `ScratchpadUUID` with a fixed ULID on both sides.
- Fix `bookmarks/load.go` to validate with `ParseID` so path recovery still runs on upgrade.
- *Tests:* the existing suites, retyped. A bookmark survives the upgrade through its path hint.

### 1.2 Frontmatter id primitives (`internal/markdown`)
- `ReadID(content) (ID, ok, malformed)` reads the `id` key.
- `WithID(content, id) []byte` does a targeted insert or replace of a single `id:` line as the first key.
  - When there is no frontmatter, it prepends `---\nid: <ulid>\n---\n`. The spec's minimal block is fine here: nearly every note already has the scaffold from migration 006, so this case is rare.
  - Fences are found through the `HasFrontmatter` contract, not a fourth ad hoc scanner.
- *Tests:* golden byte-preservation cases covering comments, quoting styles, key order, block-style lists, no frontmatter, empty frontmatter, an existing malformed id, and CRLF (refused, per N7). An `id` line must survive `RewriteFrontmatterTags`.

### 1.3 Ids on the write paths
- `Create`, daily notes and templates write the id into the file **before** the first atomic write. Mint first, then write, then index, keeping the file-first order.
- `Update` forces the known id (N5) and reports the content rewrite back to the client the same way a tag rewrite is reported.
- `Move` never touches the id.
- MCP `create_note` accepts an optional `id`, rejected if malformed or already taken.

### 1.4 Reconcile reads ids from frontmatter
- Both incremental and full reconcile read `ReadID`.
  - **Missing or malformed id:** mint one, write it atomically, then upsert using the *post-write* mtime so the next incremental pass doesn't re-read the file. Log malformed values.
  - **Frontmatter id differs from the indexed id for that path:** the frontmatter wins. Tombstone the old id.
- **Duplicates:** before any upsert, detect an id claimed by two paths and apply the N6 tie-break. Never rely on `ON CONFLICT(id)` to settle it.
- `ResolvePendingBacklinks` and registry hydration work unchanged on the new type.
- *Tests:* acceptance criteria 1–4. Also: the copied-file tie with an equal mtime, and an external id edit.

### 1.5 Tombstones
- Migration `007_tombstones.sql`: `tombstones(id TEXT PK, last_path TEXT, last_title TEXT, deleted_at INT, replaced_by TEXT)`. `last_title` is needed for the `DELETED` chip.
- Delete, including soft-delete to `.trash/`, writes a tombstone. A file that reappears with a tombstoned id (restored from trash) clears it.
- A full rebuild starts with the table empty, as the spec allows.

### 1.6 Blob identity
- Migration `008_blobs.sql`:
  - `blobs(id TEXT PK, sha256 TEXT, mime TEXT, size INT, updated_at INT)`
  - `blob_paths(path TEXT PK, blob_id TEXT, mtime_unix INT, size_bytes INT)`
  - an `items` view (N11)
- An attachment walk covers every non-`.md`, non-dotfile file under `notes/`, excluding `.trash/` and matching what `tree.go:listFiles` shows. Rehash only when `(path, mtime, size)` changes, so the incremental cost stays near zero.
- The id is `sha256-<first 16 hex>`. On a prefix collision between different digests, extend both to the full digest and log it. Identical bytes share one blob row with several `blob_paths`.
- **In-place edit:** if, within one pass, the same path's old blob disappears and a new one appears, write a tombstone for the old id with `replaced_by` set. Don't rewrite notes (N4).
- *Tests:* acceptance criterion 8. Also run `make perf-check` with attachments added to the perf vault, so cold hashing is measured against the 5 s budget.

### 1.7 Upgrade path, dry run, doctor
- An `InjectNoteIDsMigration` step, modeled on `frontmatter_migration.go`, runs after `runner.Run` and before reconcile. It logs the count of files it will touch, then calls the same `WithID` primitive. Each file is idempotent, so a partial run resumes on the next boot.
- `jasper migrate-ids --dry-run` lists the files that would change and writes nothing. Without `--dry-run` it performs the walk offline.
- New doctor check, `checkNoteIDs`, reports notes missing an id, CRLF notes that were skipped, and duplicate ids. It is appended to the `doctor.go:86-99` slice and covered in `doctor_test.go`.
- Docs: a release note warning that external tools watching `notes/` (git, Obsidian, sync clients) will see one bulk change.
- *Tests:* acceptance criterion 15.

### 1.8 Records
- Amend ADR-0032 and ADR-0012, and update the `CONTEXT.md` glossary.

---

## 7. Phase 2 — References

**Done when:** a note can hold `[[ado:workitem/12345]]`, backlinks answer for it, and the editor shows the foreign ref as a raw chip.

### 2.1 Ref extraction (`internal/markdown`)
- `ExtractRefs(content) []Ref{Target, Display, Position, Embed}` covers:
  - inline `[[…]]` and `![[…]]`, keeping the alias and embed flag that `ExtractWikilinks` currently discards
  - the frontmatter `refs:` list
- The grammar is the spec's regex plus the `file:` special case (N8) and fragment rejoin (N9). Whitespace is trimmed; comparison is otherwise exact.
- Title links resolve to `jasper:note/<id>` using the registry's same-folder-then-alphabetical rule. An unresolved title becomes `jasper:title/<title>`.

### 2.2 `refs` table
- Migration `009_refs.sql`: the spec's `refs` table plus `idx_refs_target`.
- Written in the **same transaction** as `SyncBacklinks`. Compute the added and removed sets against the prior rows inside that transaction.

### 2.3 `refs:changed` event
- Add it to the OpenAPI WS enum with payload `{source_id, added[], removed[]}`.
- Emit it after the save (file-first order) and from reconcile.
- The frontend's backlinks and item resources declare it in `invalidatedBy`.
- *Tests:* acceptance criterion 6.

### 2.4 REST read surface for the editor
The frontend stays on REST until phase 4.
- `GET /api/v1/refs/backlinks?id=<ref>` works for any ref, foreign included.
- `POST /api/v1/items/batch {ids[]}` returns, per id: title, kind, status (`OK`, `UNKNOWN` or `DELETED`), updated_at, and an excerpt for notes. Foreign ids return a raw stub.

### 2.5 Editor chips
- Extend `wikilinkPlugin.ts`. Refs get their own widget, built from `fileChipWidget`, showing a kind icon, a title and a status color.
- `jasper:note/` links show the note's current title.
- `UNKNOWN` renders muted. `DELETED` renders struck through, using `last_title`.
- The hover card shows title, kind, status, updated time and a one-line excerpt.
- Clicking navigates in-app for Jasper items. Foreign refs have no URL until phase 4, so they get no click action.
- Previews are batched per render pass through `items/batch` and cached for the session.
- Raw markup still shows on the cursor's line, as it does today.

### 2.6 `@` mention picker
- A new completion source added to the `override` array (`MarkdownEditor.tsx:439`). It searches notes and blobs.
- Selecting a note inserts `[[Title]]`, or `[[jasper:note/…|Title]]` when the new setting `editor.idNoteLinks` is on. Selecting a blob inserts an id embed. `[[` autocomplete is unchanged.
- *Tests:* acceptance criterion 13, in vitest and Playwright.

### 2.7 Blob id embeds
- New route `GET /api/v1/blobs/{blobId}`, which streams the first live path. It goes through the same hardened path resolution as the attachments route.
- A new embed widget for `![[jasper:blob/…|name]]`. A replaced blob shows a *replaced* badge with a one-click "use new version" action, which is an ordinary `Update`.
- The upload flow (`useAttachmentUpload.ts`) inserts the id embed. The file still lands in `attachments/`.
- `relocateAttachments` doesn't need to know about id embeds. Recording that "embeds by id don't care about location" is part of the ADR-0034 amendment, alongside ADR-0010.

### 2.8 Backlinks panel
- Foreign backlinks are listed in a section grouped by namespace, showing the raw ref.

### 2.9 Performance
- Extend `scripts/generate-perf-vault.sh` with a mode for 10,000 notes with 20 refs each.
- Add a Go benchmark asserting that `backlinks(target_ref)` stays under 10 ms over 200,000 rows.
- Record the full-rebuild time as the new baseline.
- *Tests:* acceptance criterion 12.

---

## 8. Phase 3 — Standalone API

**Done when:** a client with no gateway can read Jasper by id end to end and subscribe to changes.

### 3.1 gqlgen scaffold
- Add `go get -tool github.com/99designs/gqlgen@v0.17.94`. Bump `coder/websocket` to v1.8.15.
- Commit the schema at `api/graphql/schema.graphqls` and its generated code, and extend `make gen` and `make gen-check` to cover them.
- Mount `/graphql` on the 6683 router, behind CSRF, POST only. Add a `DateTime` scalar.
- Verify the `CGO_ENABLED=0` build and record the binary size delta.

### 3.2 Resolvers
- `item`, `items`, `backlinks` and `searchItems`, all following the spec's resolution rules.
- `body` has no gate, per §1.
- `searchItems` reuses `SearchFTS` for notes and matches blob file names with LIKE.
- *Tests:* acceptance criteria 2 and 9.

### 3.3 `itemChanged` subscription
- An in-process tee on the `Broadcaster` feeds a pub/sub that the subscription resolver reads, over `graphql-transport-ws`.
- The browser WebSocket hub is unchanged.

### 3.4 Federation
- **Spike first:** resolve N1 against `@apollo/composition` (run from a dev-only npm script).
- Then implement `_service` and `_entities`, and a composition test against a local stub schema defining `bt:` and `ado:` entities.
- *Tests:* acceptance criterion 11.

### 3.5 MCP additions
- `read_note` and `search_notes` return `id` and `refs`.
- New read-only `backlinks(id)` tool.
- Tool descriptions say "note ULID", not "UUID".

### 3.6 Records
- Amend ADR-0006.

---

## 9. Phase 4 — Gateway hookup (deferred)

This waits until a gateway exists. It covers:
- the `gateway.url` config
- a server-side gateway proxy, so CSP stays intact (§3, ADR-0027)
- picker fan-out to the gateway
- foreign previews and resolved foreign backlinks
- a raw-chip fallback after 1 s
- a banner when the gateway rejects requests

Acceptance criterion 14 lands here.

---

## 10. Acceptance criteria → stories

| # | Spec criterion | Story | Notes |
|---|---|---|---|
| 1 | New note gets an id; body otherwise byte-identical | 1.2, 1.3 | |
| 2 | Rename or move keeps the id; `item(id)` returns the new path | 1.3, 3.2 | |
| 3 | Deleting `.jasper/` restores identical ids | 1.4, 1.6 | |
| 4 | A copied note gets a distinct id; the original keeps its id | 1.4 | Tie-break per N6 |
| 5 | `[[ado:…]]` produces a refs row and a backlink | 2.1, 2.2, 2.4 | |
| 6 | Removing a link removes the row and emits the event | 2.2, 2.3 | Event named `refs:changed` |
| 7 | A title link resolves to `jasper:note/…` without touching the file | 2.1 | |
| 8 | Editing a PNG yields a new blob id; the old one gets a tombstone with `replacedBy` | 1.6 | |
| 9 | Deleted → `DELETED` with last title; unknown → `UNKNOWN` | 1.5, 3.2 | |
| 10 | `body` refused outside AI-read folders | — | **Dropped** (§1) |
| 11 | Subgraph composes against the stub | 3.4 | Blocked on N1 |
| 12 | 10k × 20 refs indexes within budget; backlinks under 10 ms | 2.9 | |
| 13 | `@` picker inserts the right form; chip and hover card | 2.5, 2.6 | |
| 14 | Unreachable gateway → raw chip within 1 s | Phase 4 | |
| 15 | Dry run writes nothing; real run writes only the `id` line; doctor reports 0 missing | 1.2, 1.7 | |

---

## 11. Risks

- **The upgrade is a bulk write to every user note.** Mitigations: dry run, file-first atomic writes, per-file idempotency, golden byte tests, and a doctor check. Back up the vault before the first upgrade in a real environment, and say so in the release note.
- **Reconcile now writes files.** It was read-only on `notes/` until now. A manual refresh that mints an id into a note open in an editor makes that tab's etag stale. A clean tab reloads, and a dirty tab shows the save-conflict banner, as [ADR-0011](../adr/0011-manual-refresh-over-filesystem-watcher.md) already specifies for refresh. Acceptable, but cover it with an E2E test.
- **Retyping UUIDs to ULIDs touches ~40 backend sites and ~25 OpenAPI sites.** It is mechanical but broad. Do it as story 1.1 on its own, ahead of any behavior change, so the diff can be reviewed as a pure retype.
- **Cold hashing of large attachment sets** could break the 5 s startup gate on a full rebuild. Measure it in 1.6. If needed, hash in the background and serve blob ids as `UNKNOWN` until the hash completes.
- **The federation design (N1) is unsettled**, and is the most likely cause of phase 3 rework. That is why the spike comes first.

---

## 12. Measurements (2026-10-04)

Taken on the owner's Mac mini with `make perf-check` (cold start to first `/admin/status`), after `make perf-vault`:

| Vault | Cold start | Warm start |
|---|---|---|
| 5,000 notes, no refs, 500 attachments (65 MB) | ~2 s | immediate |
| 5,000 notes × 20 refs (100k `refs` rows), 500 attachments | ~3 s | immediate |
| 10,000 notes × 20 refs (200k rows), 1,000 attachments | ~6 s | ~1 s |

The 5 s gate is specified for fewer than 5,000 notes and holds with references and attachment hashing added. The 10k × 20 figure is the full-rebuild baseline for story 2.9; it is the cost of indexing twice the specified vault, not a regression to chase. `backlinks(target_ref)` over 200k rows answers in well under a millisecond (`TestRefBacklinks_200kRows_Under10ms`).

The N1 spike (`@apollo/composition` 2.14.4): two subgraphs each declaring `interface Item @key` fail to compose; one owner with `@interfaceObject` contributors composes; a value interface with per-subgraph keyed entities composes. Option (b) is taken.

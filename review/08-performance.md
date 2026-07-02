# 08 — Performance vs. Stated NFRs

**Bottom line: the NFRs are currently met, with measurements** — `BuildTree(1000)` = **3.05ms** (budget 300ms), cold reconcile of **5000 notes = 1.73s** (budget 5s). Perf tooling is real (`scripts/perf-check.sh` gates first `/admin/status` <5s on a 5k-note vault; `perf_test.go` enforces the 300ms tree budget). The genuine exposure is not startup or the tree widget — it's the **per-tab fan-out of `useFileTree`**, which multiplies memory and CPU by the number of open tabs and threatens "feels native" at the many-tabs × large-vault corner.

This pass also **corrected three things the other audits over-called** — see "Corrections to earlier findings" below; apply them when reading `04-frontend-architecture.md`.

---

## Verified correct (do not manufacture a crisis)

- **The tree IS virtualized** — react-arborist renders through react-window with fixed `height`/`rowHeight={32}` (`FileTree.tsx:950-952`); only ~15-40 visible rows render, not 1000.
- **Reconcile IS incremental** — mtime-skip at `reconcile.go:67`; warm boots are near-instant, only cold/first boot parses everything.
- **SQLite is well-tuned** — WAL + `synchronous=NORMAL` + `busy_timeout=5000` + `wal_autocheckpoint=1000`, writer(`MaxOpenConns=1`)/reader(`MaxOpenConns=8`) split, `BEGIN IMMEDIATE` (`open.go:62-105`). FTS5 MATCH uses a proper virtual table + bind params.
- **Live preview is viewport-scoped** — `buildDecorations` iterates `view.visibleRanges` only (`livePreviewPlugin.ts:203`); a 10k-line note re-decorates only the visible ~50 lines per keystroke.
- **Search is debounced** — 200ms, min 2 chars, with cancellation (`useSearch.ts:5`). Not per-keystroke DB hits.
- **Zustand selectors are granular** — every consumer selects a slice (`useTreeStore((s) => s.field)`), so a store change wakes only the components using the changed slice.

---

## PERF-01 — `useFileTree` fan-out: 3 subscribers per open tab, each with a full tree copy + full walk per refresh

**Priority:** HIGH · **Executor:** opus · **Effort:** M · *(the perf depth behind FE-02/FE-04)*

### Evidence

Each open tab keep-alive-mounts an `EditorPane` (`App.tsx:773-786`), and each yields **three** `useFileTree()` subscribers: `EditorPane.tsx:139`, `MarkdownEditor.tsx:168`, and `wikilinkResolver.ts:82` (`useResolvedTitleSet`, which also does a full `collectNoteTitles` walk in a memo). Every subscriber, on every refresh (`useFileTree.ts:148-170`), keeps its own `useState` copy of the tree and runs a full `walkTreeCollect` DFS + `pruneStaleTreeState`. `broadcastRefresh()` fires **every** subscriber's fetch, after every save/move/create/delete and on WS `note.updated`.

### Scale where it bites

20 open tabs + 5000 notes ≈ 66 subscribers. Every note save → ~66 × `walkTreeCollect` over 5000 nodes (~330k node visits) + 66 retained deep copies of the tree (tens of MB) + 66 subtree reconciles. Autosave (2s) makes it recurring, not a one-off. Strictly linear in open tabs — invisible at 2-3 tabs, the dominant "feels native" risk at 20+. (Note: the refetch **coalescer works** — 66 subscribers still = one HTTP GET. The cost is client-side copies + walks, not network.)

### Fix

Single shared tree source (this is FE-02's zustand store): exactly one copy and one `walkTreeCollect` per refresh; components select derived slices (a memoized `Map<id,title>`, the title set) rather than each re-deriving from a private copy. Collapses O(tabs) memory and CPU to O(1). Fixing FE-02 fixes this.

---

## PERF-02 — `titleForTab` does a full-tree DFS per tab, per App render

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** S · *(this is FE-04 measured)*

### Evidence

`App.tsx:447-451` `titleForTab = (noteId) => findNoteTitle(tree.root, noteId)`; `findNoteTitle` (`App.tsx:87-99`) is a recursive full-tree DFS, called for **every** tab pill each render. 30 tabs × 5000 notes ≈ 150k node visits per App re-render, and App re-renders on many store changes.

### Fix

The FE-04 note index resolves this directly: build `Map<noteId, title>` once via `useMemo(…, [tree])`, look up O(1). The same map subsumes `findActiveNotePath`/`collectNoteIds` (`App.tsx:72-125`).

---

## PERF-03 — `GET /tree` does two full filesystem walks per request, on the hot refresh path

**Priority:** MEDIUM · **Executor:** sonnet/opus · **Effort:** M

### Evidence

`BuildTree` (`tree.go:75-89`) issues `x.List` (DB) **plus** `listFolders` (`tree.go:205`, `WalkDir` + per-dir `Canonicalize`) **plus** `listFiles` (`tree.go:251`, another full `WalkDir` + per-entry `Canonicalize`) — two disk traversals + per-entry canonicalization on every tree fetch, and the tree is refetched after every mutation and WS event.

### Scale

Measured 3ms at 1000 notes with a warm FS cache. On a cold cache, spinning disk, or WSL2/network mount, two `WalkDir`s + 2×N `Canonicalize` per refresh add real latency to a path that runs on every save. Not O(n²), but repeated O(files) disk I/O where the DB already knows the folder set.

### Fix

Derive folders from the note-path set already in the DB (one SQL read); keep the disk walk only for the empty-folder / non-md-file discovery it uniquely needs, and coalesce/cache it, invalidating on FS-change events (which DUR-01's watcher would provide). Natural pairing with DUR-01.

---

## PERF-04 — Cold reconcile: 3 transactions per file + a fresh `goldmark.New` per extraction

**Priority:** MEDIUM · **Executor:** opus · **Effort:** M

### Evidence

Per file, reconcile runs `Upsert`, `SyncTags`, `SyncBacklinks` as **3 serialized writer transactions** (`reconcile.go:98-107`), and extraction allocates a **new parser per call**: `ExtractTags` → `goldmark.New(...)` (`tags.go:46`) and `ExtractWikilinks` → `goldmark.New(...)` (`wikilinks.go:45`), i.e. 2 parser constructions + 2 full AST parses per file. The walk is serial.

### Scale

`TestStress_5000Note_FullReconcile_NoBusy` = 1.73s for 5000 *tiny* (3-line) notes — ~35% of budget. Real notes (longer bodies, more tags/links) parse slower; a vault of substantial notes or >10k notes eats the remaining headroom. Cold reconcile blocks serving (`lifecycle.go:263`, before `srv.Serve`), so it *is* the startup clock — the NFR is met today but with shrinking margin.

### Fix

Build the goldmark parsers **once** and reuse across files (they're reusable). Batch derived-data writes into one transaction per file (Upsert+tags+backlinks) or chunked N-file transactions, cutting writer round-trips ~3×. Optionally parallelize read+parse with a bounded worker pool feeding the single serialized writer.

---

## LOW (real but not NFR-threatening at stated scale)

- **PERF-05** — `searchTitlePathLike` leading-wildcard scan (`store.go:452`) is unindexable, but only a debounced fallback; 5000-row scan <5ms. *(sonnet)*
- **PERF-06** — `SearchFTS` N+1 `tagNamesForNote` (`store.go:432-439`), capped at limit ≤100 behind a 200ms debounce; fold into the main query with `group_concat`. *(sonnet)*
- **PERF-07** — Single 1.3MB JS bundle, no code splitting (`vite.config.ts` has no `manualChunks`, no `React.lazy`). Instant over loopback to download, but ~50-150ms parse/eval on the mount critical path. Lazy-load `CommandMenu`/settings/dialogs. *(sonnet)*
- **PERF-08** — `useQuickSwitcher` re-flattens the whole tree + fuzzysorts per keystroke, undebounced (`useQuickSwitcher.ts:57,70`); split the flatten into its own `useMemo([tree])`. *(sonnet)*
- **PERF-09** — No `mmap_size`/`cache_size` PRAGMA (`open.go:62`); defaults fine at 5k, `mmap_size` would help large-vault reads. *(sonnet, nitpick-adjacent)*

---

## Corrections to earlier findings (apply when reading `04-frontend-architecture.md`)

- **FE-08 (FileTree Proxy) is downgraded.** The tree is virtualized, so the per-row Proxy + `.bind` runs per *visible* row (~15-40), not per note. Still worth removing for cleanliness/type-safety, but it is **not** a 1000-note perf issue. Keep it LOW; do it with the v1.2 tree restyle.
- **FE-02's "N refetches" is imprecise.** The coalescer single-flights concurrent callers — N subscribers = **one** HTTP GET. The real cost is N in-memory tree *copies* + N `walkTreeCollect` *walks* + N reconciles (PERF-01). The fix (single shared store) is unchanged; the justification is memory/CPU, not network.
- **FE-04 is confirmed and quantified** by PERF-02 (150k node visits per App render at 30 tabs × 5k notes).

# 04 — Frontend Architecture: the Keep-Alive Tab Model and Its Fallout

The frontend is in better shape than the file sizes suggest — the save reducer is extracted and pure, TabStrip is well decomposed, typed openapi-fetch is used almost everywhere. The dominant theme instead: **infrastructure built in the single-editor era (module singletons, a global save-state slice, per-instance tree caches, hand-rolled buses) that became subtly wrong when the keep-alive multi-tab model landed** (one mounted `MarkdownEditor` per open tab, `App.tsx:774-787`).

Explicitly reviewed and judged fine, to save the next reviewer the trip: `SettingsDialog.tsx` (1056 lines but a cohesive flat form with honest rollback), `TabStrip.tsx` (properly decomposed; pointer-drag is deliberate per project memory), `useTreeStore`'s size (half is correct persistence boilerplate), and the typed API layer (`filesApi`'s raw fetch is justified for multipart).

## Reconciliation with the pending v1.2 Visual Redesign

The findings below were written against current code without knowledge of the v1.2 redesign (contract: `.planning/design/vault-redesign/DESIGN-NOTES.md`; not yet started, sequenced after Phase 15/16). Re-reading them against that contract:

- **The redesign is visual + new-surfaces, not an architectural rewrite** (contract: *"apply the design's visual language + chrome + new surfaces to the real app, NOT replace the CM6 editor"*). Every logic-layer finding — DI-03, FE-05, FE-07 — is unaffected by it.
- **The reskin is low-risk:** `theme.css` defines ~754 CSS custom properties; component hex literals are nearly all `var(--token, #fallback)` (fallbacks already near the redesign palette). v1.2's re-token is a variable swap, not a find-and-replace.
- **v1.2 reinforces the shared-layer findings by adding consumers:** the new Outline panel (reads active-editor headings), in-sidebar Search panel, and Cmd+K all consume "current editor/note state" and tree-derived data.
  - **FE-01 becomes a prerequisite** — three new surfaces would be built on the per-instance singletons that break on tab close. Fix before v1.2's right-sidebar/search work.
  - **FE-03 is timing-critical** — v1.2 phase 2 (chrome shell) and phase 9 (zen mode: conditionally hide ribbon/sidebars/tabs/breadcrumb) land heavy new conditional composition in App.tsx. Do FE-03 before phase 2.
  - **FE-04 (note index) and FE-06 (event bus)** become infrastructure the Outline/Search/Linked-mentions surfaces consume.
- **Revised verdicts:** FE-08 (FileTree Proxy) should ride v1.2 phase 5 (tree restyle), not be done standalone. The "judged fine" notes on SettingsDialog/TabStrip hold architecturally, but both are reworked by v1.2 regardless (accent/reading-font/zen controls; rectangular tab restyle).
- **New angle v1.2 raises (not a current finding):** callouts/admonitions + `==highlight==` are new block-level rendering in `livePreviewPlugin.ts` (phase 7) — verify the decoration architecture extends cleanly to block-level callouts before that phase.

---

## FE-01 — Module-level singleton editor callbacks break under keep-alive multi-tab

**Priority:** HIGH · **Executor:** opus · **Effort:** M

### Evidence

Each `MarkdownEditor` instance registers process-wide singletons on mount:

- `frontend/src/components/MarkdownEditor.tsx:178-189` — `setWikilinkHandlerCallbacks({ ... getCurrentSourceFolder: () => { const { activeNoteId, tree } = wikilinkCbRef.current; ... } })` in a `useEffect(..., [])`. `wikilinkCbRef` is **per-instance**; last-mounted editor wins.
- Same pattern at `:191-212` (`setWikilinkAutocompleteCallbacks`) and `:325-329` — `(window as any).__jasperOpenSearchPanel = () => openSearchPanel(view)` with `delete` on unmount.
- The reverse-direction singleton: `fileTree.utils.ts` `setCurrentTreeRef` (set in `FileTree.tsx:77-82`), consumed by `EditorPane` via `expandAndScrollToFolder`.

### Failure scenario

Open tabs A, B, C (C last): C's ref owns the wikilink callbacks. Close C → its editor unmounts, `wikilinkCbRef.current` freezes at C's last render, and nobody re-registers. `[[link]]` autocomplete "create note" in tab A now resolves `getCurrentSourceFolder()` against C's frozen `activeNoteId`/`tree` — **new notes land in the wrong folder**. Closing any tab also deletes `window.__jasperOpenSearchPanel` for all remaining editors.

### Fix

1. Make the callbacks read from stores instead of component refs: `getCurrentSourceFolder()` computes from `useTreeStore.getState().activeNoteId` + the shared tree (FE-02's store / FE-04's index). Register them **once at module scope** in a new `frontend/src/editor/editorBridge.ts` — not inside `MarkdownEditor`.
2. For genuinely per-view concerns (`__jasperOpenSearchPanel`), key by view: a `Map<tabId, EditorView>` or an active-view store slice; register/unregister keyed entries.
3. **Audit every `set*` registry in `editor/*` for the same pattern** — at minimum `setTagClickHandler`, `setResolvedTitlesSnapshot`, `setTagSnapshot`, `setInlineTagSnapshot`. This sweep is why the finding is opus-tier.

### Done when

Unit/E2E: open three tabs, close the last, trigger wikilink-create from the first → note lands in the correct folder. Search-panel shortcut still works after closing any tab.

---

## FE-02 — `useFileTree` is a hand-rolled server cache with per-instance tree copies

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** M

### Evidence

- `frontend/src/lib/useFileTree.ts:142-192` — each hook instance holds its own `useState<Tree | null>` and registers into a module `Set` (`treeFetchSubscribers`); `broadcastRefresh()` (`:107-110`) runs **every** instance's fetch.
- Per-tab call sites: `EditorPane.tsx:139`, `MarkdownEditor.tsx:168` — 10 open tabs ≈ 20+ subscribers, each `setTree`-ing its own copy, each re-running `pruneStaleTreeState` (`:161-163`).
- The complexity tax is self-documenting: a bespoke single-flight + trailing-tail coalescer spanning 5 module variables (`:29-97`), with a comment (`:103-106`) admitting the subscriber-inflation problem.
- `useTreeMutations.ts` awaits `broadcastRefresh()` after every mutation (`:78,:87,:95,...`).

### Why it matters

A server-cache reimplementation spread across three modules, memory duplication proportional to tabs × tree size, N React state updates per tree change — and it blocks FE-04 (a shared derived index needs a single tree location).

### Fix

Move the tree into a zustand store — `frontend/src/lib/useTreeDataStore.ts` (or a slice of `useTreeStore`): `{ tree, loading, error, refresh() }` with **one** module-level fetcher. Keep the single-flight logic; drop the subscriber Set and the trailing coalescer (a store makes tail-coalescing largely unnecessary — exactly one fetch per refresh). `useFileTree()` becomes a thin selector wrapper so all call sites keep their signature; `broadcastRefresh` becomes `useTreeDataStore.getState().refresh`.

### Done when

One network fetch per tree refresh regardless of open-tab count (assert in a test with the mock client); the `treeFetchSubscribers` Set and its comment are deleted.

---

## FE-03 — App.tsx is the tab-lifecycle engine, wired through render-phase-mutated ref registries

**Priority:** MEDIUM · **Executor:** opus · **Effort:** L

### Evidence

- `App.tsx:222-244` — per-tab ref registries built by **mutating refs during render**: `for (const tab of tabs) { if (!tabHandlerRefs.current[tab.id]) {...} }` plus a deletion loop, in the component body — fragile under StrictMode double-render and concurrent rendering.
- ~250 lines of tab lifecycle in the composition root: `flushAndClose` (`:456-477`), `closeOthers`/`closeToRight` sequential-flush loops (`:482-518`), `openRight`/`newTab` (`:521-561`), tab↔tree mirror effect (`:406-409`), hydrate/prune/promote effects (`:413-443`).
- WS fan-out is imperative relay: `onNoteUpdated: (p) => { for (const ref of Object.values(tabHandlerRefs.current)) ref.current?.onNoteUpdated(p); }` (`:270-276`) — App relays to every pane; every pane self-filters (`EditorPane.tsx:527`).

### Why it matters

The composition root owns behavior, not just composition — the sequential-close invariant ("never Promise.all the flushes") is untestable without mounting the whole app. The handler-ref registry exists only because WS events are addressed to *components* instead of *note ids*.

### Fix

1. Extract `frontend/src/lib/useTabLifecycle.ts`: `{ flushAndClose, closeOthers, closeToRight, openRight, newTab, flushConfirm, resolveFlushConfirm }`. Unit-test the sequential-close invariant there.
2. Replace `tabHandlerRefs` with note-keyed subscription: a small `noteEvents` emitter (`subscribeNoteEvents(noteId, handlers)` called from `EditorPane`'s own effect); publisher publishes once by id. The flush registry moves into `useTabStore` as a non-persisted `Map<tabId, () => Promise<void>>` registered by each pane. (FE-06's app-event bus can serve as the emitter — do FE-06 first.)
3. Move the hydrate/prune/promote effect trio (`:413-443`) into `useTabStore` actions (`hydrateAndReconcile(vaultPath, tree)`) — store logic wearing an effect costume.

Schedule after FE-02/FE-06 shrink App's surface; behavior-preserving with subtle ordering invariants — opus.

---

## FE-04 — Six duplicated recursive tree walkers; no derived note index

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** S–M

### Evidence

`App.tsx:72-99` (`findActiveNotePath`, `findNoteTitle`); `App.tsx:118-125` (`collectNoteIds`); `EditorPane.tsx:101-128` (`findNotePathInTree`); `MarkdownEditor.tsx:117-141` (`getNoteFolder`); `FileTree.tsx:679-691` (`noteIdToPath` memo); `useFileTree.ts:121-140` (`walkTreeCollect`). Hot paths: `titleForTab` (`App.tsx:447-451`) does a full-tree DFS **per tab per render**; `EditorPane` walks in render (`:611`) and in an effect (`:208`), per mounted pane.

### Why it matters

O(tabs × N) work per tree change against the 1,000+ note NFR, and six copies with slightly different null/`.md`-suffix handling that drift independently.

### Fix

Compute once per fetch, next to `walkTreeCollect`: `TreeIndex = { byId: Map<string, { path, title, parentDir }>, folderPaths: Set<string> }`, stored alongside the tree (natural fit in FE-02's store: `useTreeDataStore.getState().index`; standalone alternative: a module-level `WeakMap` keyed by tree object). Replace all six walkers with map lookups; `pruneStaleTreeState` and `pruneTabsForMissingNotes` consume the same index. Delete the local helpers.

---

## FE-05 — The global `saveState` slice is written by every keep-alive pane; the save indicator races across tabs

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** S

### Evidence

- `EditorPane.tsx:196-198` — every mounted pane mirrors its own reducer state into the single slice: `useEffect(() => { useTreeStore.getState().setSaveState(saveState); }, [saveState])`.
- Hidden panes keep live autosave timers and flush-on-blur handlers (`EditorPane.tsx:387-402,466-519`), so background saves are real.
- `StatusBar.tsx:31,77` renders the single slice.

### Failure scenario

Last-writer-wins: a hidden tab's trailing "saved" masks the active tab's "error" (and vice versa) — the one indicator whose truthfulness underpins "trustworthy autosave" can describe the wrong document.

### Fix

Scope per note: `saveStateByNoteId: Record<string, SaveState>` (in `useTreeStore` or `useTabStore`), written as `setSaveState(noteId, s)`. `StatusBar` selects the active tab's entry. Optional aggregate: surface a save-failure dot on the tab pill (the deletion dot already establishes the pattern). Add a two-tab unit test.

---

## FE-06 — Five hand-rolled pub/sub buses; the WS dispatcher hard-couples to every feature

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** M

### Evidence

- The same subscriber-Set pattern reimplemented in: `useTagBrowser.ts:17-33`, `useBacklinks` (`dispatchLinksEvent`), `useMcpGrants` (`dispatchMcpGrantsEvent`), `appShortcuts.ts:12-25` (`dispatchPhase7`), `useFileTree.ts:86-110`.
- `useSessionSync.ts:4-8` imports all the feature dispatchers; the 60-line switch (`:116-178`) routes to a mix of handler props, feature buses, and inline calls. `useTagBrowser.ts:7-10` documents the motivation: "avoids modifying useSessionSync's signature."
- Store-as-service-locator variant: `useTreeStore` holds **mutable function slots** — `forceWsReconnect`/`setForceWsReconnect`, `refreshVaultCurrent`/`setRefreshVaultCurrent` (`useTreeStore.ts:89-93,209-212`), set by `useSessionSync` (`:211`), read by `StatusBar`/`SettingsDialog` (`SettingsDialog.tsx:331`) — un-typeable service location that dies silently when unset (default `() => {}`).

### Why it matters

Every new WS event touches `useSessionSync` plus a bespoke bus; reconnect repair (SY-02) must remember to fire all of them; test seams differ per bus.

### Fix

One typed bus, `frontend/src/lib/appEvents.ts`: `emitAppEvent<E extends AppEventName>(e, payload)` / `useAppEvent(e, handler)` with a payload-map type covering WS event names + `reconnected` + UI events (`openToday`, `newTab`). `useSessionSync`'s switch collapses to origin-filter → `emitAppEvent(env.event, env.payload)` plus the vault-switch special cases; feature hooks subscribe themselves; `useSessionSync` stops importing features. Replace the two function slots with events (`emitAppEvent("ws:forceReconnect")`). Each existing bus migrates independently — safe to land incrementally. This is the enabler for SY-02 step 4 and FE-03 step 2.

---

## FE-07 — EditorPane's save orchestration is tangled in the component; keepalive PUT duplicated as raw fetch

**Priority:** MEDIUM (but sequenced first — it's the enabler for DI-03) · **Executor:** opus · **Effort:** M–L

### Evidence

- The pure reducer (`saveStateMachine.ts`) is extracted and tested — good. The orchestration is not: `performSave` (`EditorPane.tsx:279-370`) interleaves H1-rename detection → `postNoteMove` → `updateNote` → `refreshTree` → banner state → trailing-save coalescing, against 8 refs (`inFlight`, `trailingPending`, `userHasEdited`, `lastH1Sent`, `isRenameInProgress`, `lastNotePath`, ...).
- The conflict-banner "Save anyway" handler is ~50 lines of nested async inline in JSX (`EditorPane.tsx:651-703`).
- The `keepalive: true` PUT is duplicated verbatim (`EditorPane.tsx:483-491` and `:501-509`) and bypasses the typed client (hand-built URL/headers/body).

### Why it matters

The most correctness-critical flow in the app (file-FIRST save + H1↔filename binding + conflict handling) is only testable by mounting a full component with a live CM6 editor. Every ref is an unenforced invariant. DI-03 has to be threaded through this tangle — extract first.

### Fix

Extract `frontend/src/lib/useNoteSave.ts`: input `{ noteId, getContent: () => string }`; output `{ saveState, scheduleAutosave, saveNow, flush, resolveConflict(mode: "overwrite" | "discard"), onServerUpdated(p) }`. All refs move inside; H1-rename becomes a named `syncFilenameToH1()`; the two keepalive blocks collapse into one `sendKeepaliveSave()` helper (raw fetch is acceptable there — `keepalive` requires it — but write it once, and give it the If-Match header per DI-03). EditorPane keeps rendering + CM wiring only.

### Done when

The autosave/trailing-coalesce/H1-rename flow has direct unit tests against `useNoteSave` (no CM6 mount); EditorPane drops below ~500 lines; DI-03 lands on top with tests.

---

## FE-08 — Per-row-per-render `Proxy` with a double cast in the FileTree row adapter

**Priority:** LOW · **Executor:** sonnet · **Effort:** S

### Evidence

`FileTree.tsx:955-964` — the row renderer constructs `new Proxy(props.node, { get(...) { ... return typeof v === "function" ? v.bind(target) : v; } }) as unknown as NodeApi<TreeRowData>` — a Proxy plus per-method-access `.bind` allocation for every visible row on every render of a virtualized tree with a 1,000-note NFR, and the double cast means any react-arborist upgrade breaks at runtime, not compile time.

### Fix

Change `TreeRow` to accept `node: NodeApi<ArboristNode>` and read `node.data.data` explicitly (or accept `{ node, rowData: TreeRowData }`); delete the Proxy. ~15 call sites inside `TreeRow.tsx`, mechanical.

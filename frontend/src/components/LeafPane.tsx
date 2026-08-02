/**
 * LeafPane — one leaf of the recursive split-pane tree (WS-03).
 *
 * Owns a leaf-scoped `TabStrip` (row) and a keep-alive stack of `EditorPane`,
 * one per open tab — every `EditorPane` already renders its own breadcrumb /
 * inline title / body, so LeafPane's own job is composition, not
 * chrome. All tabs but the active one render `hidden` (`display:none`); CM6
 * stays mounted so cursor/scroll/undo survive a tab switch (keep-alive).
 *
 * A leaf with zero tabs (`leaf.active === null`, the "final pane never
 * collapses" invariant from `paneTree.ts`) renders a single `EditorPane` with
 * `noteId={null}`, which is EditorPane's own "no note open" placeholder.
 *
 * A pane becomes active on a click anywhere in its chrome (tab strip,
 * breadcrumb, or body) OR on focus entering it; the active leaf
 * carries `data-active-pane`. Every pane renders at full opacity — the
 * earlier inactive-pane dim was removed for readability and is NOT
 * reintroduced. In a MULTI-pane layout (`multi`), the active pane also
 * carries a 1px inset accent outline at 35% opacity — corrected from an
 * earlier 50%-opacity trial that
 * the owner found distracting; a single-pane layout shows no cue (nothing to
 * disambiguate).
 *
 * Per-tab `flushRef`/`editorHandlersRef` bookkeeping mirrors the pre-split
 * `App.tsx:239-266` pattern (TAB-13 close-flush contract), scoped to this
 * leaf's own tabs only — a ref pair per open tab, dropped when a tab closes.
 *
 * WS-09: also hosts this leaf's own Find/Replace bar, scoped to
 * the leaf's ACTIVE tab. Cmd+F/Cmd+Opt+F (jasperKeymap, routed via each
 * EditorPane's onOpenFind/onOpenFindReplace props) open it; it drives the
 * active tab's EditorView through handlerRefs — per-view CM6 search state
 * means this needs zero cross-pane coordination even for the same note open
 * in two panes. Find state/handlers live HERE, but the bar element itself
 * is passed as a `findBarSlot` prop into the
 * active tab's own EditorPane, which renders it below ITS breadcrumb — not
 * as a LeafPane-level sibling above the whole EditorPane stack.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { SearchQuery } from "@codemirror/search";
import { EditorPane, type EditorPaneHandlers } from "./EditorPane";
import { TabStrip } from "./TabStrip";
import { FindReplaceBar, type FindToggleKind, type MatchCount } from "./FindReplaceBar";
import { usePaneStore } from "../lib/usePaneStore";
import { usePaneDragStore } from "../lib/usePaneDragStore";
import type { LeafNode } from "../lib/paneTree";

interface FindBarState {
  open: boolean;
  mode: "find" | "replace";
  query: string;
  replaceText: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
}

const DEFAULT_FIND_BAR_STATE: FindBarState = {
  open: false,
  mode: "find",
  query: "",
  replaceText: "",
  caseSensitive: false,
  regexp: false,
  wholeWord: false,
};

const ZERO_MATCH_COUNT: MatchCount = { current: 0, total: 0 };

/**
 * Drop-region overlay geometry: split
 * regions cover the HALF of the pane that will become the new split; center
 * covers the full pane. Shared base style below carries the accent
 * fill/border/radius/transition, all pointer-events:none so the overlay
 * never intercepts the drag it is previewing.
 */
function overlayRectStyle(region: "left" | "right" | "top" | "bottom" | "center"): React.CSSProperties {
  switch (region) {
    case "left":
      return { top: 0, left: 0, bottom: 0, width: "50%" };
    case "right":
      return { top: 0, right: 0, bottom: 0, width: "50%" };
    case "top":
      return { top: 0, left: 0, right: 0, height: "50%" };
    case "bottom":
      return { bottom: 0, left: 0, right: 0, height: "50%" };
    case "center":
      return { inset: 0 };
  }
}

export interface LeafPaneProps {
  leaf: LeafNode;
  /** Whether THIS leaf is usePaneStore's activePaneId (click-to-focus target). */
  isActive: boolean;
  /** Whether the layout currently has more than one leaf — gates the active-pane inset accent outline off single-pane layouts. Defaults false. */
  multi?: boolean;
  reindexing: boolean;
  deletedTabIds: Set<string>;
  /** Derived from useFileTree by note UUID (TAB-12 live rename) — shared across every leaf. */
  titleForTab: (noteId: string) => string;
  /** Flush-aware close (leafId-scoped; the caller owns the flush+confirm orchestration, mirrors Plan 05's App.tsx contract). */
  onRequestClose: (leafId: string, tabId: string) => void;
  onCloseOthers: (leafId: string, tabId: string) => void;
  onCloseToRight: (leafId: string, tabId: string) => void;
  onCloseAll: (leafId: string) => void;
  onOpenRight: (leafId: string, tabId: string) => void;
  /** Pin/unpin a tab. Threaded to the tab-menu invocation site. */
  onTogglePin: (leafId: string, tabId: string) => void;
  /** Create a new untitled note and open it in THIS leaf (TAB-14, + button / ⌥T). */
  onNewTab: (leafId: string) => void;
  autosaveMs?: number;
  /** Zen mode (ZEN-01): the tab strip genuinely unmounts; the editor body fills the pane. */
  hideTabStrip?: boolean;
  /** True only for the top-left leaf — its tab strip hosts the reopen cell. */
  isTopLeftLeaf?: boolean;
  /** True only for the rightmost leaf (pre-order-last) — its tab strip hosts
   *  the collapsed right-rail reopen toggle (260721-cjt). */
  isRightmostLeaf?: boolean;
  style?: React.CSSProperties;
}

export function LeafPane({
  leaf,
  isActive,
  multi = false,
  reindexing,
  deletedTabIds,
  titleForTab,
  onRequestClose,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onOpenRight,
  onTogglePin,
  onNewTab,
  autosaveMs,
  hideTabStrip,
  isTopLeftLeaf,
  isRightmostLeaf,
  style,
}: LeafPaneProps) {
  // Per-tab ref bookkeeping, scoped to THIS leaf's own open tabs (mirrors the
  // pre-Phase-25 App.tsx-level pattern, now one instance per leaf instead of
  // one for the whole workspace).
  const handlerRefs = useRef<Record<string, MutableRefObject<EditorPaneHandlers | null>>>({});
  const flushRefs = useRef<
    Record<string, MutableRefObject<{ flush: () => Promise<void> } | null>>
  >({});
  const fallbackHandlerRef = useRef<EditorPaneHandlers | null>(null);

  for (const tab of leaf.tabs) {
    if (!handlerRefs.current[tab.id]) handlerRefs.current[tab.id] = { current: null };
    if (!flushRefs.current[tab.id]) flushRefs.current[tab.id] = { current: null };
  }
  for (const id of Object.keys(handlerRefs.current)) {
    if (!leaf.tabs.some((t) => t.id === id)) {
      delete handlerRefs.current[id];
      delete flushRefs.current[id];
    }
  }

  const leafId = leaf.id;

  // Cross-pane drag drop target (WS-01/WS-02): subscribe to the
  // transient drag store so this leaf renders its translucent region overlay
  // only while a drag is active AND the pointer is hovering THIS leaf's
  // data-droppane rect (TabStrip's window pointermove hit-tests against it).
  const hover = usePaneDragStore((s) => s.hover);
  const isDragActive = usePaneDragStore((s) => s.activeDrag !== null);
  const hoveredRegion = isDragActive && hover?.leafId === leafId ? hover.region : null;

  const handleSelectTab = useCallback(
    (tabId: string) => usePaneStore.getState().setActiveTabInLeaf(leafId, tabId),
    [leafId],
  );

  const handleReorder = useCallback(
    (fromIndex: number, toIndex: number) =>
      usePaneStore.getState().reorderTabsInLeaf(leafId, fromIndex, toIndex),
    [leafId],
  );

  // Leaf-scoped tab cycling (Alt+]/Alt+[/Ctrl+Tab) — TabStrip no longer owns
  // a workspace-wide tab list, so cycling is computed here against THIS
  // leaf's own tabs/active and committed via setActiveTabInLeaf.
  const handleCycleTab = useCallback(
    (dir: 1 | -1) => {
      if (leaf.tabs.length < 2) return;
      const idx = leaf.tabs.findIndex((t) => t.id === leaf.active);
      const next = (idx + dir + leaf.tabs.length) % leaf.tabs.length;
      usePaneStore.getState().setActiveTabInLeaf(leafId, leaf.tabs[next].id);
    },
    [leafId, leaf.tabs, leaf.active],
  );

  const handleRequestClose = useCallback(
    (tabId: string) => onRequestClose(leafId, tabId),
    [leafId, onRequestClose],
  );
  const handleCloseOthers = useCallback(
    (tabId: string) => onCloseOthers(leafId, tabId),
    [leafId, onCloseOthers],
  );
  const handleCloseToRight = useCallback(
    (tabId: string) => onCloseToRight(leafId, tabId),
    [leafId, onCloseToRight],
  );
  const handleCloseAll = useCallback(() => onCloseAll(leafId), [leafId, onCloseAll]);
  const handleOpenRight = useCallback(
    (tabId: string) => onOpenRight(leafId, tabId),
    [leafId, onOpenRight],
  );
  const handleTogglePin = useCallback(
    (tabId: string) => onTogglePin(leafId, tabId),
    [leafId, onTogglePin],
  );
  const handleNewTab = useCallback(() => onNewTab(leafId), [leafId, onNewTab]);

  // A click anywhere in this leaf's chrome (strip, breadcrumb, body) or
  // focus entering it makes this the active pane. Capture-phase so it fires
  // ahead of any inner onClick (e.g. EditorPane's click-to-focus-end handler).
  const activate = useCallback(() => {
    usePaneStore.getState().setActivePane(leafId);
  }, [leafId]);

  // Find/Replace bar (WS-09) — leaf-local, scoped to this leaf's
  // active tab. handlerRefs (above) already resolves to the active tab's
  // EditorPaneHandlers, so the bar drives THAT tab's own EditorView.
  const [findBar, setFindBar] = useState<FindBarState>(DEFAULT_FIND_BAR_STATE);
  const [matchCount, setMatchCount] = useState<MatchCount>(ZERO_MATCH_COUNT);

  const activeHandle = useCallback((): EditorPaneHandlers | null => {
    if (leaf.active === null) return null;
    return handlerRefs.current[leaf.active]?.current ?? null;
  }, [leaf.active]);

  const syncQuery = useCallback(
    (next: FindBarState) => {
      const handle = activeHandle();
      if (!handle) return;
      handle.setSearchQuery(
        new SearchQuery({
          search: next.query,
          replace: next.replaceText,
          caseSensitive: next.caseSensitive,
          regexp: next.regexp,
          wholeWord: next.wholeWord,
        }),
      );
      setMatchCount(handle.matchInfo());
    },
    [activeHandle],
  );

  const handleOpenFind = useCallback(() => {
    setFindBar((s) => ({ ...s, open: true, mode: "find" }));
  }, []);
  const handleOpenFindReplace = useCallback(() => {
    setFindBar((s) => ({ ...s, open: true, mode: "replace" }));
  }, []);

  const handleQueryChange = useCallback(
    (query: string) => {
      const next = { ...findBar, query };
      setFindBar(next);
      syncQuery(next);
    },
    [findBar, syncQuery],
  );
  const handleReplaceTextChange = useCallback(
    (replaceText: string) => {
      const next = { ...findBar, replaceText };
      setFindBar(next);
      syncQuery(next);
    },
    [findBar, syncQuery],
  );
  const handleToggle = useCallback(
    (kind: FindToggleKind) => {
      const next = { ...findBar, [kind]: !findBar[kind] };
      setFindBar(next);
      syncQuery(next);
    },
    [findBar, syncQuery],
  );

  // @codemirror/search's
  // findNext/findPrevious open CM6's own built-in search panel when the
  // query is invalid/empty — Jasper deliberately replaces that panel with
  // this custom FindReplaceBar, so it must never appear. No-op on a blank
  // (or whitespace-only) query BEFORE touching the CM6 handle. This also
  // covers Enter/Shift+Enter (FindReplaceBar's FindInput routes both through
  // these same handlers).
  const handleFindNext = useCallback(() => {
    if (findBar.query.trim() === "") return;
    const handle = activeHandle();
    if (!handle) return;
    handle.findNext();
    setMatchCount(handle.matchInfo());
  }, [activeHandle, findBar.query]);
  const handleFindPrev = useCallback(() => {
    if (findBar.query.trim() === "") return;
    const handle = activeHandle();
    if (!handle) return;
    handle.findPrevious();
    setMatchCount(handle.matchInfo());
  }, [activeHandle, findBar.query]);
  const handleReplaceNext = useCallback(() => {
    const handle = activeHandle();
    if (!handle) return;
    handle.replaceNext();
    setMatchCount(handle.matchInfo());
  }, [activeHandle]);
  const handleReplaceAllClick = useCallback(() => {
    const handle = activeHandle();
    if (!handle) return;
    handle.replaceAll();
    setMatchCount(handle.matchInfo());
  }, [activeHandle]);
  const handleCloseFindBar = useCallback(() => {
    const handle = activeHandle();
    handle?.clearSearch();
    handle?.focus();
    setFindBar(DEFAULT_FIND_BAR_STATE);
    setMatchCount(ZERO_MATCH_COUNT);
  }, [activeHandle]);

  // Bug fix (260718-n6a Task 5): root-caused via a real-CM6 integration
  // repro — FindReplaceBar's own Escape handling lives on ITS OWN container
  // `onKeyDown` (bubble-phase), which only fires when the keydown's target
  // is inside the bar's own DOM subtree (the query/replace inputs). Clicking
  // into the editor body to inspect a match — a completely natural thing to
  // do while using Find — moves DOM focus into a DIFFERENT subtree (CM6's
  // contentDOM, a sibling of the bar, not a descendant of it), so Escape
  // pressed there never reached the bar's handler: the bar stayed open and
  // its highlights stayed painted, matching the reported "only emptying the
  // input clears them" symptom. This leaf-root capture-phase listener is a
  // second entry point into the SAME choke point (handleCloseFindBar) —
  // it fires for Escape anywhere in the leaf's chrome (editor body included)
  // while the bar is open, so dismissal no longer depends on which element
  // inside the leaf currently has focus. Harmless if the bar's own handler
  // ALSO fires for the same keypress (focus was in the bar) — the close
  // routine is idempotent.
  const handleLeafKeyDownCapture = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape" && findBar.open) {
        handleCloseFindBar();
      }
    },
    [findBar.open, handleCloseFindBar],
  );

  // CR-03: re-apply the open bar's query/toggles to whichever tab just
  // became active (tab-strip click, Alt+]/Ctrl+Tab cycling, overflow
  // dropdown, or a fresh tab opening after the leaf's last tab was
  // closed) — without this, the bar's own input handlers are the ONLY
  // place syncQuery ran, so switching tabs left the new tab's EditorView
  // with no SearchQuery applied while the bar kept showing a now-stale
  // query/match-count. Deliberately keyed on `leaf.active` alone: a
  // `findBar` dep would re-run this on every keystroke, which the
  // existing input handlers already handle via their own syncQuery call.
  useEffect(() => {
    if (findBar.open) syncQuery(findBar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaf.active]);

  // Built once per render, passed as a slot into the ACTIVE tab's EditorPane
  // the bar renders below that pane's own
  // breadcrumb instead of as a LeafPane-level sibling above it. State/handlers
  // stay right here in LeafPane — this is pure slot injection, not a hoist.
  const findBarEl =
    findBar.open && leaf.active !== null ? (
      <FindReplaceBar
        mode={findBar.mode}
        query={findBar.query}
        replaceText={findBar.replaceText}
        caseSensitive={findBar.caseSensitive}
        regexp={findBar.regexp}
        wholeWord={findBar.wholeWord}
        matchCount={matchCount}
        onQueryChange={handleQueryChange}
        onReplaceTextChange={handleReplaceTextChange}
        onToggle={handleToggle}
        onFindNext={handleFindNext}
        onFindPrev={handleFindPrev}
        onReplaceNext={handleReplaceNext}
        onReplaceAll={handleReplaceAllClick}
        onClose={handleCloseFindBar}
      />
    ) : null;

  return (
    <div
      data-testid="leaf-pane"
      data-active-pane={isActive}
      data-droppane={leafId}
      onClickCapture={activate}
      onFocusCapture={activate}
      onKeyDownCapture={handleLeafKeyDownCapture}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        height: "100%",
        width: "100%",
        overflow: "hidden",
        position: "relative",
        // The active pane in a split shows a 1px inset accent outline at 35%
        // opacity — corrected from a rejected 50% trial.
        // Single-pane layouts (multi=false) show none;
        // inactive panes in a split show no dimming (readability, unchanged).
        ...(isActive && multi
          ? {
              boxShadow:
                "inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 35%, transparent)",
            }
          : {}),
        ...style,
      }}
    >
      {!hideTabStrip && (
        <TabStrip
          leafId={leafId}
          tabs={leaf.tabs}
          activeTabId={leaf.active}
          deletedTabIds={deletedTabIds}
          titleForTab={titleForTab}
          onSelectTab={handleSelectTab}
          onRequestClose={handleRequestClose}
          onCloseOthers={handleCloseOthers}
          onCloseToRight={handleCloseToRight}
          onCloseAll={handleCloseAll}
          onOpenRight={handleOpenRight}
          onTogglePin={handleTogglePin}
          onReorder={handleReorder}
          onNewTab={handleNewTab}
          onCycleTab={handleCycleTab}
          isTopLeftLeaf={isTopLeftLeaf}
          isRightmostLeaf={isRightmostLeaf}
        />
      )}
      <div style={{ position: "relative", flex: 1, minHeight: 0, minWidth: 0 }}>
        {leaf.tabs.length === 0 ? (
          <EditorPane
            noteId={null}
            hidden={reindexing}
            paneActive={isActive}
            reindexing={reindexing}
            editorHandlersRef={fallbackHandlerRef}
            autosaveMs={autosaveMs}
            onOpenFind={handleOpenFind}
            onOpenFindReplace={handleOpenFindReplace}
          />
        ) : (
          leaf.tabs.map((tab) => (
            // Keyed by leaf+tab (not just tab.id): a future drag-tab-to-move
            // can relocate a tab to a different leaf while
            // preserving its id — prefixing the key with leafId forces a
            // remount (and a fresh shared-doc-registry registration) instead
            // of silently reusing a stale EditorPane instance across panes
            // (the refs are captured once at mount).
            <EditorPane
              key={`${leafId}:${tab.id}`}
              noteId={tab.noteId}
              hidden={reindexing || tab.id !== leaf.active}
              paneActive={isActive}
              isDeleted={deletedTabIds.has(tab.noteId)}
              reindexing={reindexing}
              editorHandlersRef={handlerRefs.current[tab.id]}
              flushRef={flushRefs.current[tab.id]}
              autosaveMs={autosaveMs}
              onOpenFind={handleOpenFind}
              onOpenFindReplace={handleOpenFindReplace}
              findBarSlot={tab.id === leaf.active ? findBarEl : undefined}
            />
          ))
        )}
        {hoveredRegion !== null && (
          <div
            data-testid="drop-overlay"
            data-drop-region={hoveredRegion}
            aria-hidden="true"
            style={{
              position: "absolute",
              zIndex: 10,
              background: "color-mix(in srgb, var(--color-accent) 18%, transparent)",
              border: "2px solid color-mix(in srgb, var(--color-accent) 60%, transparent)",
              borderRadius: 6,
              transition: "all 0.08s",
              pointerEvents: "none",
              ...overlayRectStyle(hoveredRegion),
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * LeafPane — one leaf of the recursive split-pane tree (Phase 25 / WS-03).
 *
 * Owns a leaf-scoped `TabStrip` (row) and a keep-alive stack of `EditorPane`,
 * one per open tab — every `EditorPane` already renders its own breadcrumb /
 * inline title / body (Plan 05), so LeafPane's own job is composition, not
 * chrome. All tabs but the active one render `hidden` (`display:none`); CM6
 * stays mounted so cursor/scroll/undo survive a tab switch (D-01 keep-alive,
 * mirrors `App.tsx`'s pre-Phase-25 stacked-EditorPane pattern).
 *
 * A leaf with zero tabs (`leaf.active === null`, D-10's "final pane never
 * collapses" invariant from `paneTree.ts`) renders a single `EditorPane` with
 * `noteId={null}`, which is EditorPane's own "no note open" placeholder.
 *
 * A pane becomes active on a click anywhere in its chrome (tab strip,
 * breadcrumb, or body) OR on focus entering it (D-04); the active leaf
 * carries a subtle `data-active-pane` cue only (D-05 — no heavy ring, real
 * styling lands wherever this is wired into the app shell).
 *
 * Per-tab `flushRef`/`editorHandlersRef` bookkeeping mirrors the pre-Phase-25
 * `App.tsx:239-266` pattern (TAB-13 close-flush contract), scoped to this
 * leaf's own tabs only — a ref pair per open tab, dropped when a tab closes.
 */
import { useCallback, useRef, type MutableRefObject } from "react";
import { EditorPane, type EditorPaneHandlers } from "./EditorPane";
import { TabStrip } from "./TabStrip";
import { usePaneStore } from "../lib/usePaneStore";
import type { LeafNode } from "../lib/paneTree";

export interface LeafPaneProps {
  leaf: LeafNode;
  /** Whether THIS leaf is usePaneStore's activePaneId (D-05 subtle cue, D-04 click-to-focus target). */
  isActive: boolean;
  reindexing: boolean;
  deletedTabIds: Set<string>;
  /** Derived from useFileTree by note UUID (TAB-12 live rename) — shared across every leaf. */
  titleForTab: (noteId: string) => string;
  /** Flush-aware close (leafId-scoped; the caller owns the flush+confirm orchestration, mirrors Plan 05's App.tsx contract). */
  onRequestClose: (leafId: string, tabId: string) => void;
  onCloseOthers: (leafId: string, tabId: string) => void;
  onCloseToRight: (leafId: string, tabId: string) => void;
  onOpenRight: (leafId: string, tabId: string) => void;
  /** Create a new untitled note and open it in THIS leaf (TAB-14, + button / ⌥T). */
  onNewTab: (leafId: string) => void;
  autosaveMs?: number;
  /** Zen mode (ZEN-01): the tab strip genuinely unmounts; the editor body fills the pane. */
  hideTabStrip?: boolean;
  style?: React.CSSProperties;
}

export function LeafPane({
  leaf,
  isActive,
  reindexing,
  deletedTabIds,
  titleForTab,
  onRequestClose,
  onCloseOthers,
  onCloseToRight,
  onOpenRight,
  onNewTab,
  autosaveMs,
  hideTabStrip,
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
  const handleOpenRight = useCallback(
    (tabId: string) => onOpenRight(leafId, tabId),
    [leafId, onOpenRight],
  );
  const handleNewTab = useCallback(() => onNewTab(leafId), [leafId, onNewTab]);

  // D-04: a click anywhere in this leaf's chrome (strip, breadcrumb, body) or
  // focus entering it makes this the active pane. Capture-phase so it fires
  // ahead of any inner onClick (e.g. EditorPane's click-to-focus-end handler).
  const activate = useCallback(() => {
    usePaneStore.getState().setActivePane(leafId);
  }, [leafId]);

  return (
    <div
      data-testid="leaf-pane"
      data-active-pane={isActive}
      onClickCapture={activate}
      onFocusCapture={activate}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        height: "100%",
        width: "100%",
        overflow: "hidden",
        // D-05: subtle active-pane cue — no heavy border/ring, just a dim on
        // inactive panes. 0.82 (was 0.92) after the first human UAT found the
        // lighter dim too hard to notice; still opacity-only and clearly
        // non-heavy, so it stays within D-05's "subtle, no ring" contract.
        opacity: isActive ? 1 : 0.82,
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
          onOpenRight={handleOpenRight}
          onReorder={handleReorder}
          onNewTab={handleNewTab}
          onCycleTab={handleCycleTab}
        />
      )}
      <div style={{ position: "relative", flex: 1, minHeight: 0, minWidth: 0 }}>
        {leaf.tabs.length === 0 ? (
          <EditorPane
            noteId={null}
            hidden={reindexing}
            reindexing={reindexing}
            editorHandlersRef={fallbackHandlerRef}
            autosaveMs={autosaveMs}
          />
        ) : (
          leaf.tabs.map((tab) => (
            // Keyed by leaf+tab (not just tab.id): a future drag-tab-to-move
            // (Phase 26) can relocate a tab to a different leaf while
            // preserving its id — prefixing the key with leafId forces a
            // remount (and a fresh shared-doc-registry registration) instead
            // of silently reusing a stale EditorPane instance across panes
            // (see 25-05-SUMMARY.md's "captured once at mount" gap).
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
            />
          ))
        )}
      </div>
    </div>
  );
}

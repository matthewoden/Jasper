/**
 * openNoteInLeaf — opens noteId as a tab in a given leaf (not necessarily the
 * active pane) — a leaf-targeted sibling of usePaneStore's own
 * openInActivePane, needed by App.tsx's per-leaf "open to the right" / "new
 * tab" context actions (D-16/D-17 dedup rules apply identically, just scoped
 * to an explicit leafId).
 *
 * `afterTabId`, when given, inserts the new (always-unpinned) tab
 * immediately after that tab's position instead of appending at the end —
 * used by "New note to the right" (App.tsx's openRightInLeaf). Per
 * D-16/Phase 30, the insertion index is clamped to the pinned/unpinned
 * boundary so a new unpinned tab can never land inside a leaf's pinned
 * group, even when `afterTabId` itself is pinned (with more pinned tabs
 * after it).
 *
 * Extracted to its own module (not left inline in App.tsx, and not folded
 * into usePaneStore.ts's own action set) so it stays independently testable
 * without pulling in App.tsx's component tree — App.tsx's own exports must
 * stay component-only for react-refresh/only-export-components.
 */
import { _findLeaf, _updLeaf, newTabId } from "./paneTree";
import { clampIndexToPinnedBoundary } from "./tabOverflow";
import { usePaneStore } from "./usePaneStore";

export function openNoteInLeaf(leafId: string, noteId: string, afterTabId?: string): void {
  const { tree } = usePaneStore.getState();
  const leaf = _findLeaf(tree, leafId);
  if (!leaf) return;
  const existing = leaf.tabs.find((t) => t.noteId === noteId);
  if (existing) {
    usePaneStore.setState({ tree: _updLeaf(tree, leafId, { active: existing.id }) });
    return;
  }
  const tab = { id: newTabId(), noteId };
  let insertIndex = leaf.tabs.length; // default: append at the end
  if (afterTabId !== undefined) {
    const afterIdx = leaf.tabs.findIndex((t) => t.id === afterTabId);
    if (afterIdx !== -1) insertIndex = afterIdx + 1;
  }
  const pinnedCount = leaf.tabs.filter((t) => t.pinned).length;
  insertIndex = clampIndexToPinnedBoundary(insertIndex, pinnedCount, /* draggedIsPinned */ false);
  const tabs = [...leaf.tabs.slice(0, insertIndex), tab, ...leaf.tabs.slice(insertIndex)];
  usePaneStore.setState({
    tree: _updLeaf(tree, leafId, { tabs, active: tab.id }),
  });
}

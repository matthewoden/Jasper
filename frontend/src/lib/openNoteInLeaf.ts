/**
 * openNoteInLeaf targets an explicit leaf rather than the active pane, for the
 * per-leaf "open to the right" and "new tab" actions. Same dedup rules.
 *
 * `afterTabId` inserts after that position, clamped to the pinned/unpinned
 * boundary so a new unpinned tab can never land inside the pinned group — even
 * when afterTabId is itself pinned.
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

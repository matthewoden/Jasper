/**
 * SidebarToolbar — UI-SPEC §Surface 6.
 *
 * Three icon buttons in this exact order: New note, New folder, Refresh.
 * Each button: 24×24 hit target, padding 4px, transparent bg,
 * text-muted icon (lucide 16px). Native title= attribute carries the
 * tooltip text (Phase 1 deferral pattern; Phase 4 swaps to Radix Tooltip).
 *
 * Refresh in-flight visuals (UI-SPEC §Surface 6 §"Disabled state"):
 *   - icon receives `animate-spin` so the user understands "something is
 *     happening" — Tailwind's built-in keyframes
 *   - button is disabled (opacity 0.5, cursor wait) so concurrent clicks
 *     can't fire while a reindex is in flight
 *   - on error: spin stops, button re-enables. NO toast surfaced from this
 *     component — that's Plan 03-07's wiring; the parent's `onRefresh` is
 *     re-thrown so the parent can decide.
 */
import { useCallback, useState } from "react";
import { FilePlus, FolderPlus, RefreshCw } from "lucide-react";

export interface SidebarToolbarProps {
  onNewNote: () => void;
  onNewFolder: () => void;
  onRefresh: () => Promise<void>;
}

const buttonBase: React.CSSProperties = {
  width: 24,
  height: 24,
  padding: 4,
  background: "transparent",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
};

export function SidebarToolbar({
  onNewNote,
  onNewFolder,
  onRefresh,
}: SidebarToolbarProps) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
      // Parent decides whether to surface a toast (Plan 03-07 wires the
      // destructive toast for refresh failures). The toolbar's job is just
      // to clear the spin-disabled treatment so the user can retry.
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, onRefresh]);

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8 }}
      data-testid="sidebar-toolbar"
    >
      <button
        type="button"
        title="New note"
        aria-label="New note"
        onClick={onNewNote}
        style={buttonBase}
      >
        <FilePlus size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        title="New folder"
        aria-label="New folder"
        onClick={onNewFolder}
        style={buttonBase}
      >
        <FolderPlus size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        title="Refresh — pick up external file changes"
        aria-label="Refresh"
        onClick={handleRefresh}
        disabled={refreshing}
        style={{
          ...buttonBase,
          opacity: refreshing ? 0.5 : 1,
          cursor: refreshing ? "wait" : "pointer",
        }}
      >
        <RefreshCw
          size={16}
          aria-hidden="true"
          className={refreshing ? "animate-spin" : undefined}
        />
      </button>
    </div>
  );
}

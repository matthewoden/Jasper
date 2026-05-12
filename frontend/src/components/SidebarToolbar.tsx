/**
 * SidebarToolbar — Phase 6.6 update (D-08).
 *
 * Note-navigation controls ONLY (per D-08 enforcement):
 *   1. New note (FilePlus)
 *   2. New folder (FolderPlus)
 *
 * Global controls (connectivity dot, refresh button, settings menu) have been
 * relocated to StatusBar.tsx per Phase 6.6 D-08.
 *
 * `onRefresh` prop is kept with a deprecation comment for backward compat
 * with existing Sidebar.tsx call site — Plan 11 will clean up Sidebar.tsx.
 *
 * Create in-flight visuals (Gap R2-2):
 *   - `creating` prop (defaults to false) drives the New Note + New Folder
 *     buttons' disabled-state visuals (opacity 0.5, cursor "wait", disabled
 *     attribute). Owned by the parent (Sidebar reads from
 *     useTreeCreateActions().isCreating).
 */
import { FilePlus, FolderPlus } from "lucide-react";

export interface SidebarToolbarProps {
  onNewNote: () => void;
  onNewFolder: () => void;
  /**
   * @deprecated Phase 6.6 — Refresh moved to StatusBar. Kept for backward
   * compat with existing Sidebar.tsx call site. Plan 11 removes this prop.
   */
  onRefresh?: () => Promise<void>;
  /**
   * Gap R2-2 — when true, disables the New Note + New Folder buttons
   * (visually + functionally) while a create is in flight.
   */
  creating?: boolean;
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
  creating = false,
}: SidebarToolbarProps) {
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
        disabled={creating}
        style={{
          ...buttonBase,
          opacity: creating ? 0.5 : 1,
          cursor: creating ? "wait" : "pointer",
        }}
      >
        <FilePlus size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        title="New folder"
        aria-label="New folder"
        onClick={onNewFolder}
        disabled={creating}
        style={{
          ...buttonBase,
          opacity: creating ? 0.5 : 1,
          cursor: creating ? "wait" : "pointer",
        }}
      >
        <FolderPlus size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * SidebarToolbar — note-navigation controls: New note, New folder, Sort
 * (SORT-01). Today and Search moved to the activity ribbon (Phase 18);
 * global controls (connection dot, refresh, settings) live in StatusBar.
 *
 * `creating` prop disables New note + New folder while a create is in flight
 * (opacity 0.5, cursor wait, disabled attribute). Parent reads isCreating from
 * useTreeCreateActions and threads it through.
 *
 * The sort trigger (NotesSortMenu) wires itself directly to useTreeStore's
 * notesSort slice + useWorkspace's setNotesSort (optimistic PUT + revert) —
 * self-contained, not threaded through props, so this component stays the
 * single place callers need to touch for the toolbar's sort affordance.
 */
import { FilePlus, FolderPlus } from "lucide-react";

import { NotesSortMenu } from "./NotesSortMenu";
import { useTreeStore } from "../lib/useTreeStore";
import { useWorkspace } from "../lib/useWorkspace";

export interface SidebarToolbarProps {
  onNewNote: () => void;
  onNewFolder: () => void;
  /** @deprecated Refresh moved to StatusBar; prop retained for call-site compat. */
  onRefresh?: () => Promise<void>;
  /** When true, disables New note + New folder buttons while a create is in flight. */
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
  const notesSort = useTreeStore((s) => s.notesSort);
  const { setNotesSort } = useWorkspace();

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
      <NotesSortMenu
        value={notesSort}
        onSelect={(order) => void setNotesSort(order)}
      />
    </div>
  );
}

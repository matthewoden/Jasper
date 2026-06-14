/**
 * SidebarToolbar — note-navigation controls: New note, New folder, Today,
 * and Search. Global controls (connection dot, refresh, settings) live in
 * StatusBar.
 *
 * `creating` prop disables New note + New folder while a create is in flight
 * (opacity 0.5, cursor wait, disabled attribute). Parent reads isCreating from
 * useTreeCreateActions and threads it through.
 *
 * Today button disabled while useDailyNote().isLoading — re-entrancy guard is
 * in the hook; the disabled attribute is defense-in-depth.
 */
import { CalendarDays, FilePlus, FolderPlus, Search } from "lucide-react";
import { useDailyNote } from "../lib/useDailyNote";
import { useTreeStore } from "../lib/useTreeStore";

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
  const { openToday, isLoading: todayLoading } = useDailyNote();

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
      {/* Today button — opens today's daily note (get-or-create). */}
      <button
        type="button"
        title="Today (⌘⇧D)"
        aria-label="Open today's daily note"
        onClick={openToday}
        disabled={todayLoading}
        style={{
          ...buttonBase,
          opacity: todayLoading ? 0.5 : 1,
          cursor: todayLoading ? "wait" : "pointer",
        }}
      >
        <CalendarDays size={16} aria-hidden="true" />
      </button>
      {/* Search button — opens CommandMenu in search mode (Cmd+Shift+F).
          Magnifying glass implies body FTS search, not the title quick switcher
          (⌘O), so this button always opens mode='search'. */}
      <button
        type="button"
        title="Search notes (⌘⇧F)"
        aria-label="Search notes"
        onClick={() => {
          const store = useTreeStore.getState();
          store.setPaletteMode("search");
          store.setPaletteOpen(true);
        }}
        style={buttonBase}
      >
        <Search size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

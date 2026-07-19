/**
 * BookmarksPanel — lists bookmarked notes (live-titled) and virtual bookmark
 * folders (BOOK-02/03/05). Mounted by Sidebar.tsx when sidebarPanel ===
 * "bookmarks" (replaces the Plan 03 `bookmarks-panel-placeholder`).
 *
 * Composes useBookmarks() (Plan 05's hydrate + WS-refresh hook) with the tree's
 * live note titles — a bookmark only ever stores `note_id`; the title is
 * resolved on every render via a titleForTab-style tree walk (D-02, mirrors
 * App.tsx's titleForTab). Row activation goes through
 * usePaneStore.openInActivePane(noteId) (BOOK-02/D-16), never
 * useTreeStore's setActiveNoteId (Pitfall — see SidebarSearchResultRow).
 *
 * A bookmark whose noteId no longer resolves in the tree is NOT rendered
 * (defense-in-depth prune, mirrors App.tsx's pruneLayoutForMissingNotes) —
 * but only once the tree has actually loaded; while `tree === null` nothing
 * is pruned so a slow initial fetch doesn't flash bookmarks away.
 *
 * Folder collapse state is view-only client state (a local Set of collapsed
 * folder ids) — not persisted, not synced to the server.
 */
import { useCallback, useState } from "react";
import type { CSSProperties } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { useBookmarks } from "../lib/useBookmarks";
import { useFileTree } from "../lib/useFileTree";
import { usePaneStore } from "../lib/usePaneStore";
import type { TreeNode } from "../lib/treeApi";
import type { Bookmark, BookmarkFolder } from "../lib/useTreeStore";
import { BookmarksEmptyState } from "./BookmarksEmptyState";

export interface BookmarksPanelProps {
  onSelectNote?: (id: string) => void;
}

/** Live note title by UUID — mirrors App.tsx's findNoteTitle verbatim. */
function findNoteTitle(nodes: ReadonlyArray<TreeNode>, id: string): string | null {
  for (const node of nodes) {
    if (node.kind === "note" && node.id === id) return node.title;
    if (node.kind === "folder" && Array.isArray(node.children)) {
      const found = findNoteTitle(node.children, id);
      if (found !== null) return found;
    }
  }
  return null;
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 8px",
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-fg)",
  cursor: "pointer",
  border: "none",
  background: "transparent",
  width: "100%",
  textAlign: "left",
  minWidth: 0,
};
const nestedRowStyle: CSSProperties = { ...rowStyle, padding: "4px 8px 4px 24px" };

const folderRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 8px",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-fg)",
  cursor: "pointer",
  border: "none",
  background: "transparent",
  width: "100%",
  textAlign: "left",
};

const rowTitleStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

interface BookmarkRowProps {
  bookmark: Bookmark;
  title: string;
  nested: boolean;
  onOpen: () => void;
}

function BookmarkRow({ bookmark, title, nested, onOpen }: BookmarkRowProps) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", minWidth: 0 }}
      data-testid={`bookmark-row-${bookmark.id}`}
    >
      <button type="button" style={nested ? nestedRowStyle : rowStyle} onClick={onOpen}>
        <span style={rowTitleStyle}>{title}</span>
      </button>
    </div>
  );
}

interface FolderRowProps {
  folder: BookmarkFolder;
  expanded: boolean;
  onToggle: () => void;
}

function FolderRow({ folder, expanded, onToggle }: FolderRowProps) {
  return (
    <button
      type="button"
      style={folderRowStyle}
      onClick={onToggle}
      aria-expanded={expanded}
      data-testid={`bookmark-folder-${folder.id}`}
    >
      {expanded ? (
        <ChevronDown
          size={14}
          aria-hidden="true"
          style={{ color: "var(--color-muted)", flexShrink: 0 }}
        />
      ) : (
        <ChevronRight
          size={14}
          aria-hidden="true"
          style={{ color: "var(--color-muted)", flexShrink: 0 }}
        />
      )}
      <span style={rowTitleStyle}>{folder.name}</span>
    </button>
  );
}

export function BookmarksPanel({ onSelectNote }: BookmarksPanelProps) {
  // Kept for prop-shape parity with the other sidebar panels (FileTree,
  // SidebarSearchPanel) — rows activate via usePaneStore.openInActivePane
  // directly (BOOK-02/D-16), so this callback is currently unused.
  void onSelectNote;

  const { bookmarks, bookmarkFolders } = useBookmarks();
  const { tree } = useFileTree();
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());

  const titleFor = useCallback(
    (noteId: string): string =>
      (tree && findNoteTitle(tree.root, noteId)) ?? "Untitled",
    [tree],
  );

  const noteExists = useCallback(
    (noteId: string): boolean =>
      tree === null || findNoteTitle(tree.root, noteId) !== null,
    [tree],
  );

  const visibleBookmarks = bookmarks.filter((b) => noteExists(b.note_id));

  const toggleFolder = useCallback((folderId: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  const handleOpen = useCallback((noteId: string) => {
    usePaneStore.getState().openInActivePane(noteId);
  }, []);

  if (bookmarks.length === 0) {
    return <BookmarksEmptyState />;
  }

  const topLevelBookmarks = visibleBookmarks.filter((b) => b.folder_id === null);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
      }}
      data-testid="bookmarks-panel"
    >
      {bookmarkFolders.map((folder) => {
        const expanded = !collapsedFolders.has(folder.id);
        const children = visibleBookmarks.filter((b) => b.folder_id === folder.id);
        return (
          <div key={folder.id}>
            <FolderRow
              folder={folder}
              expanded={expanded}
              onToggle={() => toggleFolder(folder.id)}
            />
            {expanded &&
              children.map((b) => (
                <BookmarkRow
                  key={b.id}
                  bookmark={b}
                  title={titleFor(b.note_id)}
                  nested
                  onOpen={() => handleOpen(b.note_id)}
                />
              ))}
          </div>
        );
      })}
      {topLevelBookmarks.map((b) => (
        <BookmarkRow
          key={b.id}
          bookmark={b}
          title={titleFor(b.note_id)}
          nested={false}
          onOpen={() => handleOpen(b.note_id)}
        />
      ))}
    </div>
  );
}

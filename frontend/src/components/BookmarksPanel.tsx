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
 *
 * Per-row "…" menu (Radix DropdownMenu, self-contained per D-17 — reuses
 * TreeRowMenu's menuContainerStyle/itemStyle/destructiveItemStyle chrome, not
 * the whole component): "Remove" (destructive, calls toggleBookmark to
 * un-bookmark — no confirm dialog, instantly reversible per UI-SPEC) and
 * "Move to folder" (a Sub listing existing folders + "(No folder)" +
 * "New folder…"). Both the panel-level "New bookmark folder" trigger and the
 * per-row menu's "New folder…" item reveal the SAME inline
 * NewBookmarkFolderInput at the top of the panel (single input surface,
 * D-18 discretion — see SUMMARY).
 */
import { useCallback, useState } from "react";
import type { CSSProperties } from "react";
import { ChevronDown, ChevronRight, FolderPlus, MoreHorizontal } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import { useBookmarks } from "../lib/useBookmarks";
import { useFileTree } from "../lib/useFileTree";
import { usePaneStore } from "../lib/usePaneStore";
import type { TreeNode } from "../lib/treeApi";
import type { Bookmark, BookmarkFolder } from "../lib/useTreeStore";
import { BookmarksEmptyState } from "./BookmarksEmptyState";
import { NewBookmarkFolderInput } from "./NewBookmarkFolderInput";

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

const menuContainerStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  paddingTop: 4,
  paddingBottom: 4,
  minWidth: 200,
  maxWidth: 320,
  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
  zIndex: 50,
};
const itemStyle: CSSProperties = {
  height: 32,
  display: "flex",
  alignItems: "center",
  padding: "0 16px",
  gap: 8,
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-fg)",
  cursor: "pointer",
  outline: "none",
  userSelect: "none",
};
const destructiveItemStyle: CSSProperties = { ...itemStyle, color: "var(--color-destructive)" };
const separatorStyle: CSSProperties = {
  height: 1,
  background: "var(--color-border)",
  margin: "4px 0",
  border: "none",
};

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
  folders: BookmarkFolder[];
  onOpen: () => void;
  onRemove: () => void;
  onMoveToFolder: (folderId: string | null) => void;
  onNewFolderRequested: () => void;
}

function BookmarkRow({
  bookmark,
  title,
  nested,
  folders,
  onOpen,
  onRemove,
  onMoveToFolder,
  onNewFolderRequested,
}: BookmarkRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      style={{ display: "flex", alignItems: "center", minWidth: 0 }}
      data-testid={`bookmark-row-${bookmark.id}`}
    >
      <button type="button" style={nested ? nestedRowStyle : rowStyle} onClick={onOpen}>
        <span style={rowTitleStyle}>{title}</span>
      </button>
      <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Bookmark options"
            style={{
              flexShrink: 0,
              padding: 4,
              marginRight: 4,
              background: "transparent",
              border: "none",
              color: "var(--color-muted)",
              cursor: "pointer",
            }}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            style={menuContainerStyle}
            side="right"
            align="start"
            sideOffset={4}
          >
            <DropdownMenu.Item
              style={destructiveItemStyle}
              onSelect={() => onRemove()}
            >
              <span>Remove</span>
            </DropdownMenu.Item>
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger style={itemStyle}>
                <span>Move to folder</span>
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent style={menuContainerStyle}>
                  <DropdownMenu.Item
                    style={itemStyle}
                    onSelect={() => onMoveToFolder(null)}
                  >
                    <span>(No folder)</span>
                  </DropdownMenu.Item>
                  {folders.length > 0 && (
                    <DropdownMenu.Separator style={separatorStyle} />
                  )}
                  {folders.map((f) => (
                    <DropdownMenu.Item
                      key={f.id}
                      style={itemStyle}
                      onSelect={() => onMoveToFolder(f.id)}
                    >
                      <span>{f.name}</span>
                    </DropdownMenu.Item>
                  ))}
                  <DropdownMenu.Separator style={separatorStyle} />
                  <DropdownMenu.Item
                    style={itemStyle}
                    onSelect={() => onNewFolderRequested()}
                  >
                    <span>New folder…</span>
                  </DropdownMenu.Item>
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
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

  const { bookmarks, bookmarkFolders, toggleBookmark, moveToFolder, createFolder } =
    useBookmarks();
  const { tree } = useFileTree();
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [creatingFolder, setCreatingFolder] = useState(false);

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

  const handleRemove = useCallback(
    (noteId: string) => {
      void toggleBookmark(noteId);
    },
    [toggleBookmark],
  );

  const handleMoveToFolder = useCallback(
    (bookmarkId: string, folderId: string | null) => {
      void moveToFolder(bookmarkId, folderId);
    },
    [moveToFolder],
  );

  const handleCreateFolder = useCallback(
    async (name: string) => {
      await createFolder(name);
      setCreatingFolder(false);
    },
    [createFolder],
  );

  const renderRow = (bookmark: Bookmark, nested: boolean) => (
    <BookmarkRow
      key={bookmark.id}
      bookmark={bookmark}
      title={titleFor(bookmark.note_id)}
      nested={nested}
      folders={bookmarkFolders}
      onOpen={() => handleOpen(bookmark.note_id)}
      onRemove={() => handleRemove(bookmark.note_id)}
      onMoveToFolder={(folderId) => handleMoveToFolder(bookmark.id, folderId)}
      onNewFolderRequested={() => setCreatingFolder(true)}
    />
  );

  const header = (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        padding: "8px 8px 4px",
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        title="New bookmark folder"
        aria-label="New bookmark folder"
        onClick={() => setCreatingFolder(true)}
        style={{
          width: 24,
          height: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "none",
          borderRadius: 4,
          color: "var(--color-muted)",
          cursor: "pointer",
        }}
      >
        <FolderPlus size={14} aria-hidden="true" />
      </button>
    </div>
  );

  const newFolderInput = creatingFolder && (
    <NewBookmarkFolderInput
      onCommit={handleCreateFolder}
      onCancel={() => setCreatingFolder(false)}
    />
  );

  if (bookmarks.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        {header}
        {newFolderInput}
        <BookmarksEmptyState />
      </div>
    );
  }

  const topLevelBookmarks = visibleBookmarks.filter((b) => b.folder_id === null);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
      data-testid="bookmarks-panel"
    >
      {header}
      {newFolderInput}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
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
              {expanded && children.map((b) => renderRow(b, true))}
            </div>
          );
        })}
        {topLevelBookmarks.map((b) => renderRow(b, false))}
      </div>
    </div>
  );
}

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
import { useTreeStore, type Bookmark, type BookmarkFolder } from "../lib/useTreeStore";
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

// Row height + hover language mirrors TreeRow.tsx (32px rows, 4%-fg hover
// tint via the same Tailwind arbitrary-value class) so Bookmarks reads as
// the same list surface as Notes (Phase 27 follow-up item 5). Indent base
// (8px) matches TreeRow's own post-follow-up-item-3 base offset.
const ROW_HOVER_CLASS = "hover:bg-[rgba(255,255,255,0.04)] group";

const rowStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 32,
  padding: "0 8px",
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
const nestedRowStyle: CSSProperties = { ...rowStyle, padding: "0 8px 0 24px" };

const folderRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  height: 32,
  padding: "0 8px",
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

const toolbarRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  height: 40,
  padding: "0 8px",
  borderBottom: "1px solid var(--color-border)",
  flexShrink: 0,
};

const toolbarButtonBase: CSSProperties = {
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

interface BookmarkRowProps {
  bookmark: Bookmark;
  title: string;
  nested: boolean;
  isActive: boolean;
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
  isActive,
  folders,
  onOpen,
  onRemove,
  onMoveToFolder,
  onNewFolderRequested,
}: BookmarkRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Active-note accent highlight — same formula + 2px left bar as TreeRow's
  // isActive treatment (Phase 27 follow-up item 5).
  const activeBackground = isActive
    ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
    : undefined;
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        minWidth: 0,
        background: activeBackground,
      }}
      className={ROW_HOVER_CLASS}
      data-testid={`bookmark-row-${bookmark.id}`}
      data-active={isActive ? "true" : undefined}
    >
      {isActive && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 2,
            background: "var(--color-accent)",
          }}
        />
      )}
      <button
        type="button"
        style={{
          ...(nested ? nestedRowStyle : rowStyle),
          color: isActive ? "var(--color-fg-title)" : "var(--color-fg)",
        }}
        onClick={onOpen}
      >
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
      className={ROW_HOVER_CLASS}
      onClick={onToggle}
      aria-expanded={expanded}
      data-testid={`bookmark-folder-${folder.id}`}
    >
      {/* 16px chevron matches TreeRow's chevron size (was 14px) so the
          expand/collapse glyph reads identically across Notes + Bookmarks. */}
      {expanded ? (
        <ChevronDown
          size={16}
          aria-hidden="true"
          style={{ color: "var(--color-muted)", flexShrink: 0 }}
        />
      ) : (
        <ChevronRight
          size={16}
          aria-hidden="true"
          style={{ color: "var(--color-muted)", flexShrink: 0 }}
        />
      )}
      <span style={rowTitleStyle}>{folder.name}</span>
    </button>
  );
}

/** "New bookmark folder" toolbar trigger — SidebarToolbar-sized (24x24, muted
 *  FolderPlus) with the same fg-8%-tint hover convention as SidebarTabRow's
 *  collapse button / ActivityRibbon's RibbonButton. */
function NewBookmarkFolderButton({ onClick }: { onClick: () => void }) {
  const [hovering, setHovering] = useState(false);
  return (
    <button
      type="button"
      title="New bookmark folder"
      aria-label="New bookmark folder"
      onClick={onClick}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        ...toolbarButtonBase,
        background: hovering
          ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
          : "transparent",
      }}
    >
      <FolderPlus size={16} aria-hidden="true" />
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
  const activeNoteId = useTreeStore((s) => s.activeNoteId);
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
      isActive={activeNoteId !== null && bookmark.note_id === activeNoteId}
      folders={bookmarkFolders}
      onOpen={() => handleOpen(bookmark.note_id)}
      onRemove={() => handleRemove(bookmark.note_id)}
      onMoveToFolder={(folderId) => handleMoveToFolder(bookmark.id, folderId)}
      onNewFolderRequested={() => setCreatingFolder(true)}
    />
  );

  // Bordered 40px toolbar row — mirrors Sidebar.tsx's Notes-panel toolbar
  // chrome (same height/padding/borderBottom) so Bookmarks presents the same
  // panel-top interface as Notes (Phase 27 follow-up item 5).
  const header = (
    <div style={toolbarRowStyle}>
      <NewBookmarkFolderButton onClick={() => setCreatingFolder(true)} />
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

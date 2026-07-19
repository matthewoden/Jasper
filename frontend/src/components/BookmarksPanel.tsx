/**
 * BookmarksPanel — lists bookmarked notes (live-titled) and virtual bookmark
 * folders through the SAME shared tree engine Notes uses (quick task
 * 260719-jv1, item 5: TreeView + TreeRow, not a bespoke FolderRow/
 * BookmarkRow list). Mounted by Sidebar.tsx when sidebarPanel ===
 * "bookmarks".
 *
 * Composes useBookmarks() (hydrate + WS-refresh hook, split loading/error
 * across the initial-hydrate window) with adaptBookmarks() (bookmarkTree.
 * utils.ts) to build the same ArboristNode shape FileTree feeds into
 * TreeView. Row activation goes through usePaneStore.openInActivePane(noteId)
 * (BOOK-02/D-16), wired as TreeRow's injected onActivate — never
 * useTreeStore's setActiveNoteId.
 *
 * Bookmark-folder collapse/expand flows through react-arborist's own open
 * state (TreeView's initialOpenState + openByDefault=true, TreeRow's
 * node.toggle() on click) — no local collapsedFolders Set.
 *
 * Branch order: error (27-UI-REVIEW #1) → empty (BOOK-05) → populated tree.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { TreeApi } from "react-arborist";

import { useBookmarks } from "../lib/useBookmarks";
import { useFileTree } from "../lib/useFileTree";
import { usePaneStore } from "../lib/usePaneStore";
import { TreeView } from "./TreeView";
import { TreeRow } from "./TreeRow";
import { BookmarksEmptyState } from "./BookmarksEmptyState";
import { BookmarksErrorState } from "./BookmarksErrorState";
import { NewBookmarkFolderInput } from "./NewBookmarkFolderInput";
import { adaptBookmarks, buildBookmarkMenu, findNoteTitle } from "./bookmarkTree.utils";
import type { ArboristNode } from "./fileTree.utils";
import { FolderPlus } from "lucide-react";
import type { CSSProperties } from "react";

export interface BookmarksPanelProps {
  onSelectNote?: (id: string) => void;
}

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

const panelColumnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
};

export function BookmarksPanel({ onSelectNote }: BookmarksPanelProps) {
  // Kept for prop-shape parity with the other sidebar panels (FileTree,
  // SidebarSearchPanel) — rows activate via usePaneStore.openInActivePane
  // directly (BOOK-02/D-16), so this callback is currently unused.
  void onSelectNote;

  const {
    bookmarks,
    bookmarkFolders,
    error,
    refresh,
    toggleBookmark,
    moveToFolder,
    createFolder,
  } = useBookmarks();
  const { tree } = useFileTree();
  const [creatingFolder, setCreatingFolder] = useState(false);
  const treeRef = useRef<TreeApi<ArboristNode> | null>(null);

  const resolveTitle = useCallback(
    (noteId: string): string =>
      (tree && findNoteTitle(tree.root, noteId)) ?? "Untitled",
    [tree],
  );

  const noteExists = useCallback(
    (noteId: string): boolean =>
      tree === null || findNoteTitle(tree.root, noteId) !== null,
    [tree],
  );

  const data = useMemo(
    () => adaptBookmarks(bookmarkFolders, bookmarks, resolveTitle, noteExists),
    [bookmarkFolders, bookmarks, resolveTitle, noteExists],
  );

  // Bookmark folders start EXPANDED by default (pre-existing UX). TreeView's
  // underlying <Tree> defaults any node NOT covered by initialOpenState to
  // `openByDefault` — passed true below — so every currently-known folder
  // id being marked open here is really just for the FIRST paint; later
  // clicks flow through react-arborist's own open state via TreeRow's
  // node.toggle(), not this map.
  const initialOpenState = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const f of bookmarkFolders) out["bmfolder:" + f.id] = true;
    return out;
  }, [bookmarkFolders]);

  const handleActivate = useCallback((noteId: string) => {
    usePaneStore.getState().openInActivePane(noteId);
  }, []);

  const bookmarkMenu = useMemo(
    () =>
      buildBookmarkMenu(bookmarkFolders, {
        onRemove: (noteId) => void toggleBookmark(noteId),
        onMoveToFolder: (bookmarkId, folderId) =>
          void moveToFolder(bookmarkId, folderId),
        onNewFolder: () => setCreatingFolder(true),
      }),
    [bookmarkFolders, toggleBookmark, moveToFolder],
  );

  const handleCreateFolder = useCallback(
    async (name: string) => {
      await createFolder(name);
      setCreatingFolder(false);
    },
    [createFolder],
  );

  const noopSelectNote = useCallback(() => {
    /* bookmark rows activate via onActivate, never onSelectNote */
  }, []);

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

  if (error) {
    return (
      <div style={panelColumnStyle}>
        {header}
        {newFolderInput}
        <BookmarksErrorState onRetry={() => void refresh()} />
      </div>
    );
  }

  if (bookmarks.length === 0) {
    return (
      <div style={panelColumnStyle}>
        {header}
        {newFolderInput}
        <BookmarksEmptyState />
      </div>
    );
  }

  return (
    <div style={panelColumnStyle} data-testid="bookmarks-panel">
      {header}
      {newFolderInput}
      <TreeView<ArboristNode>
        data={data}
        treeRef={treeRef}
        initialOpenState={initialOpenState}
        openByDefault
        renderRow={({ node, style, dragHandle }) => (
          <TreeRow
            node={node}
            style={style}
            dragHandle={dragHandle}
            onSelectNote={noopSelectNote}
            onActivate={handleActivate}
            bookmarkMenu={bookmarkMenu}
          />
        )}
      />
    </div>
  );
}

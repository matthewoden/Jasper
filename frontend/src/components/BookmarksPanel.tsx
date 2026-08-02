/**
 * BookmarksPanel lists bookmarked notes and virtual folders through the SAME
 * tree engine Notes uses — TreeView + TreeRow, not a bespoke row list.
 *
 * Row activation goes through usePaneStore.openInActivePane (BOOK-02), never
 * useTreeStore's setActiveNoteId.
 *
 * Folder collapse rides react-arborist's own open state; there is deliberately
 * no local collapsedFolders Set.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { NodeApi, TreeApi } from "react-arborist";

import { useBookmarks } from "../lib/useBookmarks";
import { useFileTree } from "../lib/useFileTree";
import { usePaneStore } from "../lib/usePaneStore";
import { TreeView } from "./TreeView";
import { TreeRow } from "./TreeRow";
import { BookmarksEmptyState } from "./BookmarksEmptyState";
import { BookmarksErrorState } from "./BookmarksErrorState";
import { NewBookmarkFolderInput } from "./NewBookmarkFolderInput";
import { Tooltip } from "./Tooltip";
import {
  adaptBookmarks,
  buildBookmarkMenu,
  computeBookmarkMoveDispatch,
  findNoteTitle,
} from "./bookmarkTree.utils";
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
    <Tooltip label="New bookmark folder" side="bottom">
      <button
        type="button"
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
    </Tooltip>
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
  // directly (BOOK-02), so this callback is currently unused.
  void onSelectNote;

  const {
    bookmarks,
    bookmarkFolders,
    error,
    refresh,
    toggleBookmark,
    moveToFolder,
    createFolder,
    reorder,
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

  /**
   * Resolves react-arborist's node args into plain ids and dispatches. The
   * cross-folder-vs-reorder decision lives in the pure, unit-tested
   * computeBookmarkMoveDispatch, so this stays a thin adapter.
   */
  const handleMove = useCallback(
    (args: {
      dragNodes: NodeApi<ArboristNode>[];
      parentNode: NodeApi<ArboristNode> | null;
      index: number;
    }) => {
      const destFolderId =
        args.parentNode?.data.data.kind === "bookmark-folder"
          ? args.parentNode.data.data.folderId
          : null;

      const draggedBookmarkIds = args.dragNodes
        .map((n) => n.data.data)
        .filter((d) => d.kind === "bookmark")
        .map((d) => (d as { bookmarkId: string }).bookmarkId);

      const dispatch = computeBookmarkMoveDispatch(
        bookmarks,
        draggedBookmarkIds,
        destFolderId,
        args.index,
      );

      if (dispatch.action === "moveToFolder") {
        for (const bookmarkId of dispatch.bookmarkIds) {
          void moveToFolder(bookmarkId, dispatch.folderId);
        }
      } else if (dispatch.action === "reorder") {
        void reorder(dispatch.folderId, dispatch.orderedIds);
      }
    },
    [bookmarks, moveToFolder, reorder],
  );

  /** Bookmarks never nest inside a bookmark leaf — only into a bookmark
   *  folder or the top level. */
  const disableDrop = useCallback(
    (args: { parentNode: NodeApi<ArboristNode> }): boolean =>
      args.parentNode.data.data.kind === "bookmark",
    [],
  );

  /**
   * onRootDrop — drag-to-root (quick task 260719-jv1 follow-up). Fires
   * when a bookmark is dropped in the tree's empty area (react-arborist's
   * onMove never fires there — TreeView's window-level listener catches
   * it instead). Reuses the same moveToFolder(bookmarkId, null) mutation
   * the kebab's "(No folder)" entry already uses. Bookmarks already at
   * top level are skipped (no-op) rather than re-dispatching a move.
   */
  const handleRootDrop = useCallback(
    (dragNodes: NodeApi<ArboristNode>[]) => {
      const draggedBookmarkIds = dragNodes
        .map((n) => n.data.data)
        .filter((d) => d.kind === "bookmark")
        .map((d) => (d as { bookmarkId: string }).bookmarkId);

      for (const bookmarkId of draggedBookmarkIds) {
        const current = bookmarks.find((b) => b.id === bookmarkId);
        if (current && current.folder_id !== null) {
          void moveToFolder(bookmarkId, null);
        }
      }
    },
    [bookmarks, moveToFolder],
  );

  // Bordered 40px toolbar row — mirrors Sidebar.tsx's Notes-panel toolbar
  // chrome (same height/padding/borderBottom) so Bookmarks presents the same
  // panel-top interface as Notes.
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
        onMove={handleMove}
        disableDrop={disableDrop}
        onRootDrop={handleRootDrop}
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

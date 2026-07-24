/**
 * TreeRow — react-arborist row renderer.
 *
 * Two row variants:
 *   - Folder: ChevronRight/Down + Folder/FolderOpen icon + 14px/400 label
 *   - Note:   16px spacer (keeps labels aligned with parent folder) + label only
 *
 * Active state (note rows only): accent-tinted background + 2px accent left-border
 * absolutely positioned so the label doesn't shift.
 *
 * Hover: reveals the kebab (MoreHorizontal) button via group-hover.
 *
 * Drop indicator (D-07, Phase 29): folder rows get an inset accent
 * box-shadow while `node.willReceiveDrop` is true (the drop resolves to
 * "into this folder", not a between-rows insertion) — the sole drag
 * feedback once FileTree suppresses react-arborist's default insertion-line
 * cursor via `renderCursor={() => null}` (TreeView.tsx). BookmarksPanel
 * does not pass that prop, so its rows still get the default insertion
 * line for in-folder reordering; this box-shadow is additive there too but
 * inert unless a bookmark-folder is the live drop target.
 *
 * Wiring:
 *   - Right-click → TreeRowContextMenu wrapping the row.
 *   - Kebab → TreeRowDropdownMenu (controlled open state).
 *   - Inline rename: pendingRename match → label slot renders RenameInput.
 *   - F2 / Backspace / Delete + double-click → onRequestRename / onRequestDelete.
 *   - dragHandle ref makes the row a react-dnd drag source.
 *   - handleClick sets useTreeStore.selectedRow so the document-level F2 listener
 *     in App.tsx can route rename even when DOM focus is in the editor textarea.
 *
 * XSS hardening: this file MUST NOT use the React inner-HTML escape hatch
 * (the `dangerously...` prop). Labels are rendered as React text content,
 * which escapes by default — even a malicious title with <script> renders as
 * plain text. The vitest case `TestRow_DoesNotUseDangerously...InnerHTML`
 * enforces this — the forbidden token is split in the test source so this
 * comment can mention the escape-hatch family without tripping the gate.
 */
import { useCallback, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { NodeApi } from "react-arborist";
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileText,
  Folder,
  FolderOpen,
  Image,
  MoreHorizontal,
  Paperclip,
} from "lucide-react";

import { useTreeStore } from "../lib/useTreeStore";
import { useTreeMutations } from "../lib/useTreeMutations";
import { useReveal } from "../lib/useReveal";
import { useMcpGrants } from "../lib/useMcpGrants";
import { usePaneStore } from "../lib/usePaneStore";
import { RenameInput } from "./RenameInput";
import { Tooltip } from "./Tooltip";
import {
  TreeRowContextMenu,
  TreeRowDropdownMenu,
  type TreeRowMenuKind,
} from "./TreeRowMenu";

export type FolderNodeData = {
  kind: "folder";
  path: string;
  name: string;
};

export type NoteNodeData = {
  kind: "note";
  id: string;
  path: string;
  title: string;
  /**
   * Wall-clock UTC of last filesystem mtime (wire TreeNode.updated_at).
   * Threaded through so sortTree (fileTree.utils.ts) can order by
   * "modified" without a second lookup pass over the wire tree (SORT-01).
   */
  updated_at?: string;
  /**
   * True filesystem birthtime when available, else undefined (wire
   * TreeNode.created — SORT-01/D-04). Read by sortTree's "created" order.
   */
  created?: string;
};


export type FileNodeData = {
  kind: "file";
  path: string;
  name: string;
  parentNoteId?: string;
};

/**
 * A bookmarked note row (quick task 260719-jv1, item 5). id is the
 * bookmark's own opaque id (NOT the note's id) — Remove/reorder act on
 * bookmarkId; activation and title resolution act on noteId.
 */
export type BookmarkNodeData = {
  kind: "bookmark";
  bookmarkId: string;
  noteId: string;
  title: string;
};

/** A virtual bookmark-grouping folder — NOT a filesystem folder. */
export type BookmarkFolderNodeData = {
  kind: "bookmark-folder";
  folderId: string;
  name: string;
};

export type TreeRowData =
  | FolderNodeData
  | NoteNodeData
  | FileNodeData
  | BookmarkNodeData
  | BookmarkFolderNodeData;

/**
 * Bookmark-row menu descriptor — injected so TreeRow can render the
 * Remove / Move-to-folder / New-folder menu (TreeRowMenu's "bookmark"
 * branch) without importing bookmarks-specific hooks itself. Only
 * meaningful for `kind: "bookmark"` rows.
 */
export interface BookmarkMenuDescriptor {
  onRemove: (noteId: string) => void;
  onMoveToFolder: (bookmarkId: string, folderId: string | null) => void;
  folders: Array<{ id: string; name: string }>;
  onNewFolder: () => void;
}

export interface TreeRowProps {
  node: NodeApi<TreeRowData>;
  style: CSSProperties;
  onSelectNote: (id: string) => void;
  onRequestRename?: (target: TreeRowData) => void;
  onRequestDelete?: (target: TreeRowData) => void;
  onRequestNewNote?: (parentPath: string) => void;
  onRequestNewFolder?: (parentPath: string) => void;
  siblingNames?: string[];
  commitRename?: (target: TreeRowData, newValue: string) => Promise<void>;
  /**
   * react-arborist drag source registration ref. Attached to the row container
   * so react-dnd's HTML5Backend can register it as a drag source. Optional so
   * unit tests that omit it stay valid; react-arborist always provides it at runtime.
   */
  dragHandle?: (el: HTMLDivElement | null) => void;
  /**
   * Bookmark-row activation seam (BOOK-02/D-16) — routes to
   * usePaneStore.openInActivePane instead of onSelectNote/setActiveNote.
   * Only consulted for `kind: "bookmark"` rows.
   */
  onActivate?: (noteId: string) => void;
  /** Present iff this row (or its caller) is bookmark-capable. */
  bookmarkMenu?: BookmarkMenuDescriptor;

  /**
   * Bulk-selection wiring (D-19, CTX-02). FileTree.tsx computes these
   * against its own treeRef (react-arborist's live selection) and threads
   * them down here; only wired into the right-click ContextMenu variant —
   * the kebab DropdownMenu is always single-row-scoped, per UI-SPEC's
   * "right-click with a multi-selection" framing.
   */
  getSelectionCount?: () => number;
  onBulkOpenTabs?: () => void;
  onBulkOpenInSplit?: () => void;
  onBulkBookmark?: () => void;
  onBulkDelete?: () => void;

  /**
   * Note-row Bookmark toggle wiring (CTX-02, D-17). FileTree.tsx owns the
   * SINGLE `useBookmarks()` hydrate/subscribe instance and threads its
   * `isBookmarked`/`toggleBookmark` down here — TreeRow deliberately does
   * NOT call `useBookmarks()` itself (unlike useReveal/useMcpGrants/
   * useTreeMutations above): react-arborist renders one TreeRow per visible
   * row, and `useBookmarks()` fires its own GET /bookmarks + WS-subscriber
   * registration on every mount, so calling it per-row multiplied that
   * hydrate fetch by the row count and caused a burst of near-simultaneous
   * store writes (every row re-renders on every OTHER row's fetch
   * resolving) — this both wasted bandwidth and produced enough render
   * churn during virtualized mount/scroll to detach rows mid-interaction
   * in E2E (Rule 1 fix). Only meaningful for note rows.
   */
  isNoteBookmarked?: (noteId: string) => boolean;
  onToggleNoteBookmark?: (noteId: string) => void;
}

const muted: CSSProperties = { color: "var(--color-muted)", flexShrink: 0 };

function parentDirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function noop() {
  /* placeholder when callback not wired */
}


type IconComponent = React.FC<{ size?: number; style?: CSSProperties; "aria-hidden"?: boolean | "true" }>;
function getFileIconComponent(filename: string): IconComponent {
  const ext = filename.lastIndexOf(".") >= 0
    ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
    : "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico"].includes(ext)) return Image;
  if (["pdf", "doc", "docx", "txt", "csv", "tsv"].includes(ext)) return FileText;
  return FileIcon;
}


export function TreeRow({
  node,
  style,
  onSelectNote,
  onRequestRename,
  onRequestDelete,
  onRequestNewNote,
  onRequestNewFolder,
  siblingNames = [],
  commitRename,
  dragHandle,
  onActivate,
  bookmarkMenu,
  getSelectionCount,
  onBulkOpenTabs,
  onBulkOpenInSplit,
  onBulkBookmark,
  onBulkDelete,
  isNoteBookmarked,
  onToggleNoteBookmark,
}: TreeRowProps) {
  const activeNoteId = useTreeStore((s) => s.activeNoteId);
  const pendingRename = useTreeStore((s) => s.pendingRename);
  const { reveal } = useReveal();
  const {
    directLevelFor,
    levelFor,
    grant: grantMcp,
    revoke: revokeMcp,
    inheritedGrantOn,
  } = useMcpGrants();
  const [contextSelectionCount, setContextSelectionCount] = useState(0);
  const pulseTarget = useTreeStore((s) => s.pulseTarget);
  const liveLabel = useTreeStore((s) =>
    node.data.kind === "note" ? s.liveLabels[node.data.id] : undefined,
  );
  const muts = useTreeMutations();
  const data = node.data;
  const isFolder = data.kind === "folder";
  const isFile = data.kind === "file";
  const isBookmark = data.kind === "bookmark";
  const isBookmarkFolder = data.kind === "bookmark-folder";
  const isActive =
    (data.kind === "note" && activeNoteId === data.id) ||
    (isBookmark && activeNoteId === (data as BookmarkNodeData).noteId);
  const isSelected = node.isSelected === true;
  const isDailyFolder = isFolder && (data as FolderNodeData).path === "daily";
  const isAttachmentsFolder = isFolder && (data as FolderNodeData).name === "attachments";
  // Base offset computed from SidebarTabRow's actual icon column (Phase 27
  // follow-up fix round, item 3): the tab icon's left edge sits at the
  // header's 16px paddingLeft + half the 30x30 tab button's own
  // (30-16)/2=7px icon-centering inset = 23px. This row's own
  // chevron/spacer (16px) + the 4px chevron-to-icon gap (below) always
  // contribute 20px between the row's paddingLeft and its folder icon /
  // note label, so the base must be 23 - 20 = 3 for those to land on the
  // same column at level 0. (A prior 8px base undershot the tabs' column
  // by 5px.) Per-level step (16 * node.level) is unchanged.
  const indent = 3 + 16 * node.level;

  const grantLevel = isFolder
    ? directLevelFor((data as FolderNodeData).path)
    : null;

  // MCP AI-grant concept only applies to real filesystem paths (folder/note/
  // file rows) — bookmark and bookmark-folder rows are virtual and never
  // carry a grant.
  const effectiveAiLevel: 1 | 2 | null =
    data.kind === "folder" || data.kind === "note" || data.kind === "file"
      ? levelFor(data.path)
      : null;

  const [kebabOpen, setKebabOpen] = useState(false);

  // Note-row-only menu wiring (CTX-02/WS-06): Open in split targets the
  // shared usePaneStore action directly (same pattern as useTreeMutations/
  // useReveal/useMcpGrants above — TreeRow owns its own hook wiring rather
  // than having FileTree drill single-target callbacks through). Bookmark
  // state/toggle is prop-driven instead (see isNoteBookmarked/
  // onToggleNoteBookmark doc comment on TreeRowProps — per-row
  // useBookmarks() calls caused a hydrate-fetch storm).
  const noteIsBookmarked =
    data.kind === "note" ? isNoteBookmarked?.(data.id) : undefined;
  const handleToggleBookmark =
    data.kind === "note"
      ? () => onToggleNoteBookmark?.((data as NoteNodeData).id)
      : undefined;
  const handleOpenInSplit =
    data.kind === "note"
      ? () =>
          usePaneStore
            .getState()
            .openNoteInNewSplit((data as NoteNodeData).id, "row")
      : undefined;

  // D-19/Pitfall 5: read the live selection at menu-OPEN time (not
  // row-render time) so a stale count never leaks into an already-open
  // menu. Only the right-click ContextMenu variant is bulk-aware.
  const handleContextMenuOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setContextSelectionCount(getSelectionCount ? getSelectionCount() : 0);
      }
    },
    [getSelectionCount],
  );

  const inheritedGrant = isFolder
    ? inheritedGrantOn((data as FolderNodeData).path)
    : null;

  const handleGrant = isFolder
    ? (level: 1 | 2) => {
        setKebabOpen(false);
        void grantMcp((data as FolderNodeData).path, level);
      }
    : undefined;
  const handleRevoke = isFolder
    ? () => {
        setKebabOpen(false);
        void revokeMcp((data as FolderNodeData).path);
      }
    : undefined;

  // Rename never applies to bookmark / bookmark-folder rows — pendingRename.kind
  // is typed RenameKind ("note" | "folder" | "file"), so the equality check
  // below already narrows data.kind away from the bookmark kinds entirely.
  const isRenamingThis =
    pendingRename != null &&
    pendingRename.kind === data.kind &&
    pendingRename.target ===
      (data.kind === "folder"
        ? data.path
        : data.kind === "note"
          ? data.id
          : data.path);

  const handleCancelRename = useCallback(async () => {
    const pr = useTreeStore.getState().pendingRename;
    if (pr?.isNew) {
      try {
        if (data.kind === "note") {
          await muts.deleteNote(data.id);
        } else if (data.kind === "folder" || data.kind === "file") {
          await muts.deleteFolder(data.path, true);
        }
        // bookmark / bookmark-folder rows never enter the ephemeral
        // (isNew) rename flow — nothing to clean up on cancel.
      } catch (err) {
        console.warn(
          "TreeRow: failed to delete ephemeral node on cancel; tree may show stale row until next refresh",
          err,
        );
      }
    }
    useTreeStore.getState().endRename();
  }, [data, muts]);

  const handleClick = (e: React.MouseEvent) => {
    if (isRenamingThis) return;

    const isMac =
      typeof navigator !== "undefined" &&
      navigator.platform.toLowerCase().includes("mac");
    const isModifierClick = e.metaKey || (!isMac && e.ctrlKey) || e.shiftKey;
    if (isModifierClick) {
      node.handleClick(e);
      e.stopPropagation();
      return;
    }

    if (isFile) {
      useTreeStore.getState().setActiveFilePath(data.path);
      return;
    }

    // Bookmark rows activate via the injected onActivate seam (BOOK-02/
    // D-16 — usePaneStore.openInActivePane), never onSelectNote/
    // setActiveNote. Bookmark-folder rows just toggle open/closed, same
    // gesture as a real folder but without touching useTreeStore's
    // selectedRow (that store is note-tree-specific).
    if (isBookmarkFolder) {
      node.toggle();
      return;
    }
    if (isBookmark) {
      useTreeStore.getState().setActiveFilePath(null);
      onActivate?.((data as BookmarkNodeData).noteId);
      return;
    }

    useTreeStore.getState().setSelectedRow(
      data.kind === "folder"
        ? { kind: "folder", target: data.path }
        : { kind: "note", target: (data as NoteNodeData).id },
    );
    if (isFolder) {
      node.toggle();
    } else {
      useTreeStore.getState().setActiveFilePath(null);
      onSelectNote((data as NoteNodeData).id);
      useTreeStore.getState().setActiveNote((data as NoteNodeData).id);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onRequestRename) onRequestRename(data);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isRenamingThis) return;
    if (e.key === "F2") {
      e.preventDefault();
      e.stopPropagation();
      if (onRequestRename) onRequestRename(data);
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      e.stopPropagation();
      if (onRequestDelete) onRequestDelete(data);
      return;
    }
  };

  const activeBackground = isActive
    ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
    : undefined;
  const selectedBackground =
    isSelected && !isActive
      ? "color-mix(in srgb, var(--color-accent) 4%, transparent)"
      : undefined;
  const rowBackground = activeBackground ?? selectedBackground;

  // D-07 (Phase 29): react-arborist's willReceiveDrop getter is only ever
  // true for the folder currently acting as the drop's destination parent
  // AND when the drop resolves to "into the folder" rather than a
  // between-rows insertion index (see tree-api.js willReceiveDrop) — so
  // this box-shadow naturally only ever appears on folder rows, with no
  // extra isFolder guard needed.
  const willReceiveDrop = node.willReceiveDrop === true;

  const dataTreeRowValue =
    data.kind === "folder" || data.kind === "file"
      ? data.path
      : data.kind === "note"
        ? data.id
        : data.kind === "bookmark"
          ? data.bookmarkId
          : data.folderId;

  const isPulseTarget =
    !isFile &&
    !isBookmark &&
    !isBookmarkFolder &&
    pulseTarget !== null &&
    pulseTarget.kind === data.kind &&
    pulseTarget.target === (data.kind === "folder" ? data.path : (data as NoteNodeData).id);

  // "New note" / "New folder" only ever target real filesystem paths —
  // bookmark rows never offer create actions (their kebab menu is Remove /
  // Move-to-folder / New-folder-for-bookmarks, wired separately below).
  const parentPathForCreate =
    data.kind === "folder"
      ? data.path
      : data.kind === "note" || data.kind === "file"
        ? parentDirOf(data.path)
        : "";

  const renameInitial =
    data.kind === "folder"
      ? data.name
      : data.kind === "note"
        ? data.title.endsWith(".md")
          ? data.title.slice(0, -3)
          : data.title
        : data.kind === "bookmark"
          ? data.title
          : data.name; // file | bookmark-folder

  const displayLabel =
    data.kind === "folder" || data.kind === "file"
      ? data.name
      : data.kind === "note"
        ? (liveLabel ?? data.title)
        : data.kind === "bookmark"
          ? data.title
          : data.name; // bookmark-folder

  // Note-row hover tooltip (UAT gap-closure group B, item 8): created/modified
  // in the user's LOCAL timezone via toLocaleString(). Missing `created`
  // (older notes / filesystems without reliable birthtime, D-04) shows
  // Modified only; missing both renders no tooltip at all. Built here (not
  // inline in the JSX below) so we can decide whether to drop the native
  // `title=` ellipsis attribute — showing both a native title AND this rich
  // Radix tooltip on hover would double up, so the native title only survives
  // on non-note rows / dateless notes (D-07's own ellipsis carve-out).
  const noteDateTooltipContent =
    data.kind === "note" && (data.created != null || data.updated_at != null) ? (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {/* UAT round 2: the date VALUES were unreadably dim at
            --color-muted. Labels stay muted for hierarchy; the actual
            date/time strings render at --color-fg (normal weight, 12px) so
            they're clearly legible. */}
        {data.created != null && (
          <span style={{ fontSize: 12 }}>
            <span style={{ color: "var(--color-muted)" }}>Created </span>
            <span style={{ color: "var(--color-fg)" }}>
              {new Date(data.created).toLocaleString()}
            </span>
          </span>
        )}
        {data.updated_at != null && (
          <span style={{ fontSize: 12 }}>
            <span style={{ color: "var(--color-muted)" }}>Modified </span>
            <span style={{ color: "var(--color-fg)" }}>
              {new Date(data.updated_at).toLocaleString()}
            </span>
          </span>
        )}
      </div>
    ) : null;

  const labelSpan = (
    <span
      style={{
        flex: 1,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: 14,
        fontWeight: 400,
        color: isActive ? "var(--color-fg-title)" : "var(--color-fg)",
      }}
      title={noteDateTooltipContent === null ? displayLabel : undefined}
      data-tree-row-label
    >
      {displayLabel}
    </span>
  );

  const labelOrInput = isRenamingThis ? (
    <RenameInput
      initialValue={renameInitial}
      isFolder={isFolder}
      siblingNames={siblingNames}
      isNew={pendingRename?.isNew}
      onCommit={async (v) => {
        if (!commitRename) {
          useTreeStore.getState().endRename();
          return;
        }
        await commitRename(data, v);
      }}
      onCancel={() => { void handleCancelRename(); }}
    />
  ) : noteDateTooltipContent !== null ? (
    // DnD SAFETY: wraps ONLY this inner label span, never the draggable row
    // container — react-arborist's drag source, inline rename, and the
    // right-click context menu all live on `rowContent` below, untouched.
    <Tooltip content={noteDateTooltipContent} side="right">
      {labelSpan}
    </Tooltip>
  ) : (
    labelSpan
  );

  // "Show in file manager" only ever applies to a real filesystem path.
  const revealPath =
    data.kind === "folder" || data.kind === "note" || data.kind === "file"
      ? data.path
      : undefined;

  // Menu rowKind mapping. bookmark-folder rows get NO menu at all (kebab or
  // context) — mirrors the pre-existing bespoke FolderRow, which was a bare
  // toggle button with zero affordances.
  const menuRowKind: TreeRowMenuKind | null = isFile
    ? "file"
    : isFolder
      ? "folder"
      : data.kind === "note"
        ? "note"
        : isBookmark
          ? "bookmark"
          : null;

  const bookmarkData = isBookmark ? (data as BookmarkNodeData) : null;
  const bookmarkMenuHandlers = bookmarkData
    ? {
        bookmarkFolders: bookmarkMenu?.folders ?? [],
        onRemoveBookmark: () => bookmarkMenu?.onRemove(bookmarkData.noteId),
        onMoveBookmarkToFolder: (folderId: string | null) =>
          bookmarkMenu?.onMoveToFolder(bookmarkData.bookmarkId, folderId),
        onNewBookmarkFolder: () => bookmarkMenu?.onNewFolder(),
      }
    : {};

  const rowContent = (
    <div
      ref={dragHandle}
      style={{
        ...style, // react-arborist virtualization: top, height, etc.
        position: "relative",
        display: "flex",
        alignItems: "center",
        height: 32,
        paddingLeft: indent,
        paddingRight: 16,
        cursor: "pointer",
        background: rowBackground,
        boxShadow: willReceiveDrop
          ? "inset 0 0 0 2px color-mix(in srgb, var(--color-accent) 50%, transparent)"
          : undefined,
      }}
      className={
        "hover:bg-[rgba(255,255,255,0.04)] group" +
        (isPulseTarget ? " jasper-pulse-target" : "")
      }
      data-tree-row={dataTreeRowValue}
      data-tree-row-kind={data.kind}
      data-ai-level={effectiveAiLevel ?? undefined}
      data-active={isActive ? "true" : undefined}
      data-selected={isSelected ? "true" : undefined}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      role="treeitem"
      aria-expanded={isFolder || isBookmarkFolder ? node.isOpen : undefined}
      aria-current={isActive ? "page" : undefined}
      tabIndex={0}
      title={isDailyFolder ? "Daily notes" : undefined}
    >
      {/* D-15: flat per-level indent guides for nested rows — mock draws an
          unconditional full-height vertical line at every ancestor level (no
          VSCode-style last-child termination). Anchored to the same
          `indent = 3 + 16*level` geometry as the row's own paddingLeft; +7
          centers the 1px line under the folder/note icon column rather than
          the chevron. Level 0 rows render none (nothing to guide against). */}
      {node.level > 0 &&
        Array.from({ length: node.level }, (_, level) => (
          <span
            key={`indent-guide-${level}`}
            aria-hidden="true"
            data-testid="tree-indent-guide"
            style={{
              position: "absolute",
              left: 3 + 16 * level + 7,
              top: 0,
              bottom: 0,
              width: 1,
              // UAT round 3 (D-15 brighten): owner feedback — the guide lines
              // following open folders read too faint. Swapped from
              // --color-border (#2a2a2e, the structural-divider token) to
              // --color-border-input (#34343a, the already-established
              // "slightly stronger" token used for input/scrollbar-thumb
              // borders) at the same 70% mix — a small, deliberate brightness
              // bump that stays well under a full divider's contrast.
              background:
                "color-mix(in srgb, var(--color-border-input) 70%, transparent)",
            }}
          />
        ))}
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
      {/* Chevron (folders + bookmark-folders) or 16px spacer (notes/bookmarks —
          keeps labels aligned with parent folder labels). */}
      {isFolder || isBookmarkFolder ? (
        node.isOpen ? (
          <ChevronDown size={16} style={muted} aria-hidden="true" />
        ) : (
          <ChevronRight size={16} style={muted} aria-hidden="true" />
        )
      ) : (
        <span aria-hidden="true" style={{ width: 16, flexShrink: 0 }} />
      )}
      {/* 4px gap between chevron/spacer and icon/label */}
      <span aria-hidden="true" style={{ width: 4, flexShrink: 0 }} />
      {/* Folder icon — folders + bookmark-folders; notes/bookmarks render label only.
          daily/ folder → CalendarDays (accent); attachments/ → Paperclip (muted);
          bookmark-folders always get the generic Folder/FolderOpen glyph. */}
      {(isFolder || isBookmarkFolder) && (
        <>
          {isDailyFolder ? (
            <CalendarDays
              size={16}
              style={{ color: "var(--color-accent)", flexShrink: 0 }}
              aria-hidden="true"
            />
          ) : isAttachmentsFolder ? (
            <Paperclip
              size={16}
              style={muted}
              aria-hidden="true"
            />
          ) : node.isOpen ? (
            <FolderOpen size={16} style={muted} aria-hidden="true" />
          ) : (
            <Folder size={16} style={muted} aria-hidden="true" />
          )}
          <span aria-hidden="true" style={{ width: 4, flexShrink: 0 }} />
        </>
      )}
      {/* File nodes: type-based icon — Image (.png/.jpg/etc), FileText (.pdf/.doc/etc),
          generic File for everything else. */}
      {isFile && (() => {
        const FileIco = getFileIconComponent(data.name);
        return (
          <>
            <FileIco size={16} style={muted} aria-hidden={true} />
            <span aria-hidden="true" style={{ width: 4, flexShrink: 0 }} />
          </>
        );
      })()}
      {/* Label OR inline-rename input. React text-content escapes by default — XSS gate. */}
      {labelOrInput}
      {/* data-ai-level drives the violet tint on granted folders via theme.css */}
      {/* Kebab — wraps TreeRowDropdownMenu; hidden until row hover or focus-within.
          Omitted entirely for bookmark-folder rows (menuRowKind === null). */}
      {menuRowKind !== null && (
        <TreeRowDropdownMenu
          rowKind={menuRowKind}
          noteId={data.kind === "note" ? data.id : undefined}
          parentPath={parentPathForCreate}
          onOpen={
            data.kind === "note"
              ? () => onSelectNote((data as NoteNodeData).id)
              : undefined
          }
          onNewNote={() =>
            onRequestNewNote ? onRequestNewNote(parentPathForCreate) : noop()
          }
          onNewFolder={
            isFolder
              ? () =>
                  onRequestNewFolder
                    ? onRequestNewFolder(parentPathForCreate)
                    : noop()
              : undefined
          }
          onRename={() =>
            onRequestRename ? onRequestRename(data) : noop()
          }
          onDelete={() =>
            onRequestDelete ? onRequestDelete(data) : noop()
          }
          onReveal={revealPath !== undefined ? () => void reveal(revealPath) : undefined}
          activeLevel={isFolder ? grantLevel : null}
          onGrant={handleGrant}
          onRevoke={handleRevoke}
          inheritedGrant={inheritedGrant}
          onOpenInSplit={handleOpenInSplit}
          isBookmarked={noteIsBookmarked}
          onToggleBookmark={handleToggleBookmark}
          {...bookmarkMenuHandlers}
          open={kebabOpen}
          onOpenChange={setKebabOpen}
        >
          <button
            type="button"
            data-tree-row-kebab
            aria-label="Row menu"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="invisible group-hover:visible group-focus-within:visible"
            style={{
              background: "transparent",
              border: "none",
              padding: 4,
              color: "var(--color-muted)",
              cursor: "pointer",
              width: 24,
              height: 24,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
        </TreeRowDropdownMenu>
      )}
    </div>
  );

  if (menuRowKind === null) {
    // bookmark-folder rows: no context menu either (matches the
    // pre-existing bare-toggle FolderRow — zero affordances).
    return rowContent;
  }

  return (
    <TreeRowContextMenu
      rowKind={menuRowKind}
      noteId={data.kind === "note" ? data.id : undefined}
      parentPath={parentPathForCreate}
      onOpen={
        data.kind === "note"
          ? () => onSelectNote((data as NoteNodeData).id)
          : undefined
      }
      onNewNote={() =>
        onRequestNewNote ? onRequestNewNote(parentPathForCreate) : noop()
      }
      onNewFolder={
        isFolder
          ? () =>
              onRequestNewFolder
                ? onRequestNewFolder(parentPathForCreate)
                : noop()
          : undefined
      }
      onRename={() =>
        onRequestRename ? onRequestRename(data) : noop()
      }
      onDelete={() =>
        onRequestDelete ? onRequestDelete(data) : noop()
      }
      onReveal={revealPath !== undefined ? () => void reveal(revealPath) : undefined}
      activeLevel={isFolder ? grantLevel : null}
      onGrant={handleGrant}
      onRevoke={handleRevoke}
      inheritedGrant={inheritedGrant}
      onOpenInSplit={handleOpenInSplit}
      isBookmarked={noteIsBookmarked}
      onToggleBookmark={handleToggleBookmark}
      selectionCount={contextSelectionCount > 1 ? contextSelectionCount : undefined}
      onBulkOpenTabs={onBulkOpenTabs}
      onBulkOpenInSplit={onBulkOpenInSplit}
      onBulkBookmark={onBulkBookmark}
      onBulkDelete={onBulkDelete}
      onOpenChange={handleContextMenuOpenChange}
      {...bookmarkMenuHandlers}
    >
      {rowContent}
    </TreeRowContextMenu>
  );
}

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
import { RenameInput } from "./RenameInput";
import {
  TreeRowContextMenu,
  TreeRowDropdownMenu,
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
};


export type FileNodeData = {
  kind: "file";
  path: string;
  name: string;
  parentNoteId?: string;
};

export type TreeRowData = FolderNodeData | NoteNodeData | FileNodeData;

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
  const pulseTarget = useTreeStore((s) => s.pulseTarget);
  const liveLabel = useTreeStore((s) =>
    node.data.kind === "note" ? s.liveLabels[node.data.id] : undefined,
  );
  const muts = useTreeMutations();
  const data = node.data;
  const isFolder = data.kind === "folder";
  const isFile = data.kind === "file";
  const isActive = !isFolder && !isFile && data.kind === "note" && activeNoteId === data.id;
  const isSelected = node.isSelected === true;
  const isDailyFolder = isFolder && (data as FolderNodeData).path === "daily";
  const isAttachmentsFolder = isFolder && (data as FolderNodeData).name === "attachments";
  const indent = 16 + 16 * node.level;

  const grantLevel = isFolder
    ? directLevelFor((data as FolderNodeData).path)
    : null;

  const effectiveAiLevel: 1 | 2 | null = levelFor(data.path);

  const [kebabOpen, setKebabOpen] = useState(false);

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
        } else {
          await muts.deleteFolder(data.path, true);
        }
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
    ? "color-mix(in srgb, var(--color-accent) 8%, transparent)"
    : undefined;
  const selectedBackground =
    isSelected && !isActive
      ? "color-mix(in srgb, var(--color-accent) 4%, transparent)"
      : undefined;
  const rowBackground = activeBackground ?? selectedBackground;

  const dataTreeRowValue = isFolder
    ? data.path
    : isFile
      ? data.path
      : (data as NoteNodeData).id;

  const isPulseTarget =
    !isFile &&
    pulseTarget !== null &&
    pulseTarget.kind === data.kind &&
    pulseTarget.target === (data.kind === "folder" ? data.path : (data as NoteNodeData).id);

  const parentPathForCreate = isFolder
    ? data.path
    : parentDirOf(data.path);

  const renameInitial =
    data.kind === "folder"
      ? data.name
      : data.kind === "note"
        ? data.title.endsWith(".md")
          ? data.title.slice(0, -3)
          : data.title
        : data.name;

  const displayLabel =
    isFolder
      ? data.name
      : isFile
        ? data.name
        : (liveLabel ?? (data as NoteNodeData).title);

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
  ) : (
    <span
      style={{
        flex: 1,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: 14,
        fontWeight: 400,
        color: "var(--color-fg)",
      }}
      title={displayLabel}
      data-tree-row-label
    >
      {displayLabel}
    </span>
  );

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
      aria-expanded={isFolder ? node.isOpen : undefined}
      aria-current={isActive ? "page" : undefined}
      tabIndex={0}
      title={isDailyFolder ? "Daily notes" : undefined}
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
      {/* Chevron (folders only) or 16px spacer (notes — keeps labels aligned with folder labels). */}
      {isFolder ? (
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
      {/* Folder icon — folders only; notes render label only.
          daily/ folder → CalendarDays (accent); attachments/ → Paperclip (muted). */}
      {isFolder && (
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
      {/* Kebab — wraps TreeRowDropdownMenu; hidden until row hover or focus-within. */}
      <TreeRowDropdownMenu
        rowKind={isFile ? "file" : isFolder ? "folder" : "note"}
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
        onReveal={() => void reveal(data.path)}
        activeLevel={isFolder ? grantLevel : null}
        onGrant={handleGrant}
        onRevoke={handleRevoke}
        inheritedGrant={inheritedGrant}
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
    </div>
  );

  return (
    <TreeRowContextMenu
      rowKind={isFile ? "file" : isFolder ? "folder" : "note"}
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
      onReveal={() => void reveal(data.path)}
      activeLevel={isFolder ? grantLevel : null}
      onGrant={handleGrant}
      onRevoke={handleRevoke}
      inheritedGrant={inheritedGrant}
    >
      {rowContent}
    </TreeRowContextMenu>
  );
}

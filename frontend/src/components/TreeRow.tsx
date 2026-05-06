/**
 * TreeRow — react-arborist row renderer per UI-SPEC §Tree row anatomy.
 *
 * Two row variants:
 *   - Folder: ChevronRight/Down (collapsed/expanded) + Folder/FolderOpen
 *             icon + 14px/400/text-fg label
 *   - Note:   16px chevron-spacer + 14px/400/text-fg label (NO icon — per
 *             UI-SPEC "Notes render label only")
 *
 * Active state (note rows only — folders cannot be active):
 *   activeNoteId from useTreeStore matches node.data.id ⇒
 *     - background: color-mix(in srgb, var(--color-accent) 8%, transparent)
 *     - 2px solid var(--color-accent) left-border absolutely positioned
 *       so the label doesn't shift
 *
 * Hover state (group + group-hover):
 *   - background: rgba(255, 255, 255, 0.04)  via "hover:bg-..." utility
 *   - reveals the kebab `⋯` (MoreHorizontal) button
 *
 * Plan 03-07 wires:
 *   - Right-click → <TreeRowContextMenu> wraps the row root.
 *   - Kebab click → <TreeRowDropdownMenu> with controlled open state.
 *   - Inline rename: when useTreeStore.pendingRename matches this row,
 *     the label slot renders <RenameInput> instead of the static span.
 *   - F2 / Backspace / Delete keys + double-click on the row trigger
 *     onRequestRename / onRequestDelete callbacks.
 *   - react-arborist's `dragHandle` ref is attached to the row container
 *     so the HTML5Backend registers the row as a drag source (Gap R2-1).
 *   - Gap R2-4 (Plan 03-20): handleClick sets useTreeStore.selectedRow so
 *     App.tsx's document-level F2 listener can route rename to this row
 *     even when DOM focus has shifted to the editor textarea
 *     (EditorPane.useEffect → loadStatus === "loaded" focuses the
 *     textarea on note selection). The local handleKeyDown F2 path
 *     stays as a fallback for the auto-focused-row case.
 *
 * XSS hardening: this file MUST NOT use the React inner-HTML escape
 * hatch (the `dangerously...` prop). Labels are rendered as React text
 * content, which escapes by default — even a malicious title with
 * <script> renders as plain text. The vitest case
 * `TestRow_DoesNotUseDangerously...InnerHTML` enforces this — the
 * forbidden token is split across the test source so this comment can
 * mention the family of escape hatches without tripping the gate.
 */
import { useState, type CSSProperties, type KeyboardEvent } from "react";
import type { NodeApi } from "react-arborist";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  MoreHorizontal,
} from "lucide-react";

import { useTreeStore } from "../lib/useTreeStore";
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

export type TreeRowData = FolderNodeData | NoteNodeData;

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
   * react-arborist's drag source registration callback ref. Forwarded
   * from the <Tree> children render-prop. Attached to the row container
   * <div> so react-dnd's HTML5Backend registers the row as a drag
   * source. Without this attachment, drag-and-drop is silently dead in
   * the browser (Gap R2-1 closure — 03-RESEARCH-ROUND2.md §1.2). The
   * prop is optional so existing unit tests that omit it stay valid;
   * react-arborist always provides it at runtime.
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
  const data = node.data;
  const isFolder = data.kind === "folder";
  const isActive = !isFolder && activeNoteId === data.id;
  // 16px indent step (UI-SPEC §Layout). 16px base padding-left + 16px per
  // depth level. Verified by TestRow_IndentScalesWithLevel.
  const indent = 16 + 16 * node.level;

  const [kebabOpen, setKebabOpen] = useState(false);

  const isRenamingThis =
    pendingRename != null &&
    pendingRename.kind === data.kind &&
    pendingRename.target === (data.kind === "folder" ? data.path : data.id);

  const handleClick = () => {
    if (isRenamingThis) return; // guarded — clicks inside the input are handled by RenameInput
    // Gap R2-4 (Plan 03-20): track this row as the F2 routing target.
    // App.tsx's document-level keydown listener reads
    // useTreeStore.selectedRow at fire time to dispatch rename to the
    // right row even after the editor textarea has stolen focus
    // (EditorPane focuses the textarea on loadStatus === "loaded").
    // Both folder and note rows participate — folders rename via the
    // same selectedRow → startRename path.
    useTreeStore.getState().setSelectedRow(
      data.kind === "folder"
        ? { kind: "folder", target: data.path }
        : { kind: "note", target: data.id },
    );
    if (isFolder) {
      node.toggle();
    } else {
      onSelectNote(data.id);
      useTreeStore.getState().setActiveNote(data.id);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onRequestRename) onRequestRename(data);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isRenamingThis) return; // RenameInput owns key handling while open
    if (e.key === "F2") {
      e.preventDefault();
      // Gap 3 — keep arborist's keymap from also handling F2. Without
      // stopPropagation react-arborist's tree-container keymap receives
      // the bubble and may swallow / re-route the key before our
      // onRequestRename callback fires.
      e.stopPropagation();
      if (onRequestRename) onRequestRename(data);
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      // Gap 3 — same reason as F2 above.
      e.stopPropagation();
      if (onRequestDelete) onRequestDelete(data);
      return;
    }
  };

  const activeBackground = isActive
    ? "color-mix(in srgb, var(--color-accent) 8%, transparent)"
    : undefined;

  const dataTreeRowValue = isFolder ? data.path : data.id;

  // Compute the parent path used for "New note" / "New folder" from this row's
  // context menu or kebab. Folder rows create children inside themselves;
  // note rows create siblings (same parent folder).
  const parentPathForCreate = isFolder
    ? data.path
    : parentDirOf(data.path);

  // For the rename input we strip ".md" from notes; folders keep the
  // full name. The caller (FileTree) reattaches ".md" before calling
  // moveNote.
  const renameInitial =
    data.kind === "folder"
      ? data.name
      : data.title.endsWith(".md")
        ? data.title.slice(0, -3)
        : data.title;

  const labelOrInput = isRenamingThis ? (
    <RenameInput
      initialValue={renameInitial}
      isFolder={isFolder}
      siblingNames={siblingNames}
      onCommit={async (v) => {
        if (!commitRename) {
          useTreeStore.getState().endRename();
          return;
        }
        await commitRename(data, v);
      }}
      onCancel={() => useTreeStore.getState().endRename()}
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
      title={isFolder ? data.name : data.title}
      data-tree-row-label
    >
      {isFolder ? data.name : data.title}
    </span>
  );

  const rowContent = (
    <div
      // Gap R2-1: arborist hands us a callback ref via the children
      // render-prop; attaching it on the row container is what registers
      // the row as a react-dnd drag source. Without this, ALL drag
      // events are silently dropped — both Playwright synthetic AND
      // real mouse drags (03-RESEARCH-ROUND2.md §1.2).
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
        background: activeBackground,
      }}
      className="hover:bg-[rgba(255,255,255,0.04)] group"
      data-tree-row={dataTreeRowValue}
      data-tree-row-kind={data.kind}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      role="treeitem"
      aria-expanded={isFolder ? node.isOpen : undefined}
      aria-current={isActive ? "page" : undefined}
      tabIndex={0}
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
      {/* Chevron (folders only) or 16px spacer (notes — keeps labels
          aligned with their parent folder labels per UI-SPEC). */}
      {isFolder ? (
        node.isOpen ? (
          <ChevronDown size={16} style={muted} aria-hidden="true" />
        ) : (
          <ChevronRight size={16} style={muted} aria-hidden="true" />
        )
      ) : (
        <span aria-hidden="true" style={{ width: 16, flexShrink: 0 }} />
      )}
      {/* xs (4px) gap between chevron/spacer and icon/label */}
      <span aria-hidden="true" style={{ width: 4, flexShrink: 0 }} />
      {/* Folder icon — folders only; notes render label only per UI-SPEC */}
      {isFolder && (
        <>
          {node.isOpen ? (
            <FolderOpen size={16} style={muted} aria-hidden="true" />
          ) : (
            <Folder size={16} style={muted} aria-hidden="true" />
          )}
          <span aria-hidden="true" style={{ width: 4, flexShrink: 0 }} />
        </>
      )}
      {/* Label OR inline-rename input. React text-content escape is
          the XSS gate; no inner-HTML escape hatch anywhere. */}
      {labelOrInput}
      {/* Kebab — wraps a TreeRowDropdownMenu so click reveals the same
          item set as the right-click context menu. Hidden until row
          hover or focus-within (Plan 03-06 chassis kept the visibility
          behavior verbatim). */}
      <TreeRowDropdownMenu
        rowKind={isFolder ? "folder" : "note"}
        noteId={!isFolder ? (data as NoteNodeData).id : undefined}
        parentPath={parentPathForCreate}
        onOpen={
          !isFolder
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
        open={kebabOpen}
        onOpenChange={setKebabOpen}
      >
        <button
          type="button"
          data-tree-row-kebab
          aria-label="Row menu"
          // Stop propagation in the bubbling phase so the row's onClick
          // (which would toggle/select) doesn't also fire. We intentionally
          // do NOT call e.preventDefault — Radix's DropdownMenu.Trigger
          // (via asChild) needs the native click to fire its own
          // open-on-click handler.
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
      rowKind={isFolder ? "folder" : "note"}
      noteId={!isFolder ? (data as NoteNodeData).id : undefined}
      parentPath={parentPathForCreate}
      onOpen={
        !isFolder
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
      onRename={() => (onRequestRename ? onRequestRename(data) : noop())}
      onDelete={() => (onRequestDelete ? onRequestDelete(data) : noop())}
    >
      {rowContent}
    </TreeRowContextMenu>
  );
}

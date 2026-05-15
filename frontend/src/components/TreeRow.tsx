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

// Plan 07-26 (UAT-2 R1-7): non-markdown files surfaced in the sidebar tree.
// parentNoteId is set for files inside an attachments/ folder so the click
// handler can route to /api/v1/attachments/{noteId}/{filename}.
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

// Plan 07-26 (UAT-2 R1-7): pick a lucide icon component based on file extension.
// Returns a React component (not an element) so the caller renders it with size/style.
type IconComponent = React.FC<{ size?: number; style?: CSSProperties; "aria-hidden"?: boolean | "true" }>;
function getFileIconComponent(filename: string): IconComponent {
  const ext = filename.lastIndexOf(".") >= 0
    ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
    : "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico"].includes(ext)) return Image;
  if (["pdf", "doc", "docx", "txt", "csv", "tsv"].includes(ext)) return FileText;
  return FileIcon;
}

// Plan 07-26 (UAT-2 R1-7): click routing for non-markdown files.
// Files inside attachments/ open in a new tab via the attachments REST endpoint.
// Files outside attachments/ are deferred — console.warn, no navigation.
function handleFileClick(filePath: string, parentNoteId?: string): void {
  const idx = filePath.indexOf("/attachments/");
  if (idx >= 0 && parentNoteId) {
    const filename = filePath.substring(idx + "/attachments/".length);
    const url = `/api/v1/attachments/${parentNoteId}/${encodeURIComponent(filename)}`;
    window.open(url, "_blank");
    return;
  }
  console.warn(`[TreeRow] file click deferred (not in attachments/ or no parentNoteId): ${filePath}`);
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
  // UAT follow-up 2026-05-12 — pulse highlight when navigated to via breadcrumb.
  const pulseTarget = useTreeStore((s) => s.pulseTarget);
  // Plan 04 (UX-08): live H1 label override for note rows. Falls back to
  // the canonical title from the wire tree when no override is present.
  // Folder rows are unaffected (folders use `data.name`).
  const liveLabel = useTreeStore((s) =>
    node.data.kind === "note" ? s.liveLabels[node.data.id] : undefined,
  );
  const muts = useTreeMutations();
  const data = node.data;
  const isFolder = data.kind === "folder";
  const isFile = data.kind === "file";
  // Plan 07-26: file nodes are never "active" (no note loading path).
  const isActive = !isFolder && !isFile && data.kind === "note" && activeNoteId === data.id;
  // UX-13 (gap-closure 2026-05-09) — render multi-select state.
  // node.isSelected reads from react-arborist's Redux selection store.
  // Without this surface, Cmd+click and Shift+click set aria-selected on
  // the outer arborist wrapper but produce ZERO visible change in the
  // tree, leading users to report multi-select as "broken" even though
  // the underlying selection state is correct (the Bug C Playwright
  // scenario passes precisely because it queries aria-selected, not
  // pixels). Active styling outranks selected styling — a row that's
  // both active AND selected uses the strong accent treatment so the
  // active anchor is never visually demoted by joining a multi-select.
  const isSelected = node.isSelected === true;
  // Phase 7 D-18: root-level daily/ folder gets the CalendarDays icon in accent color.
  // Exact match on data.path === "daily" — sub-paths like "archive/daily" keep the
  // default Folder/FolderOpen icon. Level-0 guard is implicit: react-arborist only
  // gives path === "daily" to root-level folders (sub-paths always have a prefix slash
  // separator, e.g. "projects/daily"). Exact string match is sufficient.
  const isDailyFolder = isFolder && (data as FolderNodeData).path === "daily";
  // Plan 07-20 (UAT #13 C4): attachments/ folders get a Paperclip icon at any depth.
  // Matched by folder NAME (not path) so root-level "attachments" and nested
  // "projects/jasper/attachments" both receive the icon. Folder contents are still
  // not indexed as notes (walk.go unchanged) — the folder appears empty when expanded.
  // File visibility inside attachments/ is a v2 polish item.
  const isAttachmentsFolder = isFolder && (data as FolderNodeData).name === "attachments";
  // 16px indent step (UI-SPEC §Layout). 16px base padding-left + 16px per
  // depth level. Verified by TestRow_IndentScalesWithLevel.
  const indent = 16 + 16 * node.level;

  const [kebabOpen, setKebabOpen] = useState(false);

  // Plan 07-26: file nodes are never renamed (no rename flow for non-markdown files).
  const isRenamingThis =
    !isFile &&
    pendingRename != null &&
    pendingRename.kind === data.kind &&
    pendingRename.target === (data.kind === "folder" ? data.path : data.kind === "note" ? data.id : "");

  // Bug D fix — handleCancelRename: when pendingRename.isNew is true the
  // node was just created (never confirmed) and the user pressed Escape or
  // blurred without changing the placeholder name. In that case we delete
  // the ephemeral node and then close the rename input. For ordinary
  // F2/double-click renames (isNew is falsy) we just close the input.
  const handleCancelRename = useCallback(async () => {
    const pr = useTreeStore.getState().pendingRename;
    if (pr?.isNew) {
      // Ephemeral node: delete it (best-effort — if the delete fails we
      // still close the input so the user isn't stuck).
      try {
        if (data.kind === "note") {
          await muts.deleteNote(data.id);
        } else {
          await muts.deleteFolder(data.path, true);
        }
      } catch (err) {
        // Log and fall through to endRename so the input always closes.
        console.warn(
          "TreeRow: failed to delete ephemeral node on cancel; tree may show stale row until next refresh",
          err,
        );
      }
    }
    useTreeStore.getState().endRename();
  }, [data, muts]);

  const handleClick = (e: React.MouseEvent) => {
    if (isRenamingThis) return; // guarded — clicks inside the input are handled by RenameInput

    // UX-13 / Pattern 4 (Phase 5.5 Plan 07): delegate Cmd / Ctrl / Shift
    // to react-arborist's built-in multi-select. node.handleClick reads
    // e.metaKey + e.shiftKey and calls selectMulti / selectContiguous /
    // activate as appropriate. RESEARCH §A4: Cmd on Mac, Ctrl on Win/Linux —
    // accept either for cross-platform correctness.
    //
    // Pitfall 5: when modifier is present, RETURN immediately after
    // node.handleClick(e). Do NOT also fire onSelectNote / setActiveNote /
    // setSelectedRow — that would switch the loaded note despite the user
    // only intending to multi-select.
    //
    // WR-01 (Phase 5.5 gap-closure Plan 10) — gate ctrlKey on non-Mac
    // platforms. On macOS, Ctrl-click is the OS-level secondary-click
    // gesture that opens the right-click context menu; intercepting it
    // for multi-select breaks platform conventions. Mac users get
    // multi-select via Cmd-click (metaKey) and contextmenu via
    // Ctrl-click; other platforms keep both Ctrl and Cmd as multi-select
    // modifiers. Convention: read navigator.platform (matches
    // editor/jasperKeymap's existing platform-detection convention).
    const isMac =
      typeof navigator !== "undefined" &&
      navigator.platform.toLowerCase().includes("mac");
    const isModifierClick = e.metaKey || (!isMac && e.ctrlKey) || e.shiftKey;
    if (isModifierClick) {
      node.handleClick(e);
      // Plan 17 Bug C (UX-13): react-arborist's DefaultRow component
      // (the outer wrapper around our TreeRow's <div role="treeitem">)
      // also has `onClick={node.handleClick}`. Without stopPropagation,
      // the click bubbles to the outer wrapper which fires
      // node.handleClick AGAIN — toggling Cmd-click's selectMulti right
      // back to deselect. Net effect: Cmd-click was inert, multi-select
      // never reached the DOM, multi-delete consequently inert too.
      // See 05.5-17c-INVESTIGATION.md for the full trace.
      e.stopPropagation();
      return;
    }

    // Plan 07-26: file nodes use a dedicated click handler (attachment open or deferred).
    if (isFile) {
      handleFileClick(data.path, (data as FileNodeData).parentNoteId);
      return;
    }

    // No modifier — existing single-click semantics (Plan 03-20 selectedRow + activate).
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
        : { kind: "note", target: (data as NoteNodeData).id },
    );
    if (isFolder) {
      node.toggle();
    } else {
      onSelectNote((data as NoteNodeData).id);
      useTreeStore.getState().setActiveNote((data as NoteNodeData).id);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Plan 07-26: file nodes are read-only in the sidebar — no rename flow.
    if (isFile) return;
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
      // Plan 07-26: file nodes are read-only — skip rename trigger.
      if (!isFile && onRequestRename) onRequestRename(data);
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      // Gap 3 — same reason as F2 above.
      e.stopPropagation();
      // Plan 07-26: file nodes are read-only — skip delete trigger.
      if (!isFile && onRequestDelete) onRequestDelete(data);
      return;
    }
  };

  const activeBackground = isActive
    ? "color-mix(in srgb, var(--color-accent) 8%, transparent)"
    : undefined;
  // UX-13 selected-but-not-active styling. Half the accent intensity of
  // the active treatment so the active anchor still reads as primary
  // when both states co-occur (single-click activates AND selects).
  const selectedBackground =
    isSelected && !isActive
      ? "color-mix(in srgb, var(--color-accent) 4%, transparent)"
      : undefined;
  const rowBackground = activeBackground ?? selectedBackground;

  // Plan 07-26: file nodes use path as the row identifier (no note id).
  const dataTreeRowValue = isFolder
    ? data.path
    : isFile
      ? data.path
      : (data as NoteNodeData).id;

  // UAT follow-up 2026-05-12 — does the pulse target match this row?
  // Plan 07-26: file nodes never pulse (no pulse-target tracking for files).
  const isPulseTarget =
    !isFile &&
    pulseTarget !== null &&
    pulseTarget.kind === data.kind &&
    pulseTarget.target === (data.kind === "folder" ? data.path : (data as NoteNodeData).id);

  // Compute the parent path used for "New note" / "New folder" from this row's
  // context menu or kebab. Folder rows create children inside themselves;
  // note rows create siblings (same parent folder).
  // Plan 07-26: file nodes use the file's parent directory.
  const parentPathForCreate = isFolder
    ? data.path
    : parentDirOf(data.path);

  // For the rename input we strip ".md" from notes; folders keep the
  // full name. The caller (FileTree) reattaches ".md" before calling
  // moveNote.
  // Plan 07-26: file nodes are never renamed, so renameInitial is unused.
  const renameInitial =
    data.kind === "folder"
      ? data.name
      : data.kind === "note"
        ? data.title.endsWith(".md")
          ? data.title.slice(0, -3)
          : data.title
        : data.name; // file — unreachable in practice (isFile guard in handleDoubleClick)

  // Plan 04 (UX-08): note rows prefer the live H1 label (from useTreeStore.liveLabels)
  // over the canonical wire-tree title; folders always render their name.
  // Plan 07-26: file rows render their filename (data.name).
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
        background: rowBackground,
      }}
      className={
        "hover:bg-[rgba(255,255,255,0.04)] group" +
        (isPulseTarget ? " jasper-pulse-target" : "")
      }
      data-tree-row={dataTreeRowValue}
      data-tree-row-kind={data.kind}
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
      {/* Folder icon — folders only; notes render label only per UI-SPEC.
          Phase 7 D-18: root-level daily/ folder renders CalendarDays in accent color.
          Phase 7 Plan 20 (UAT #13 C4): attachments/ folder renders Paperclip in muted color. */}
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
      {/* Plan 07-26 (UAT-2 R1-7): file nodes render a type-based icon.
          Image for images (.png/.jpg/etc), FileText for documents (.pdf/.doc/etc),
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
      {/* Label OR inline-rename input. React text-content escape is
          the XSS gate; no inner-HTML escape hatch anywhere. */}
      {labelOrInput}
      {/* Kebab — wraps a TreeRowDropdownMenu so click reveals the same
          item set as the right-click context menu. Hidden until row
          hover or focus-within (Plan 03-06 chassis kept the visibility
          behavior verbatim). */}
      <TreeRowDropdownMenu
        rowKind={isFolder ? "folder" : "note"}
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
          // Plan 07-26: file nodes are read-only — no rename.
          !isFile && onRequestRename ? onRequestRename(data) : noop()
        }
        onDelete={() =>
          // Plan 07-26: file nodes are read-only — no delete via tree.
          !isFile && onRequestDelete ? onRequestDelete(data) : noop()
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
        // Plan 07-26: file nodes are read-only — no rename.
        !isFile && onRequestRename ? onRequestRename(data) : noop()
      }
      onDelete={() =>
        // Plan 07-26: file nodes are read-only — no delete via tree.
        !isFile && onRequestDelete ? onRequestDelete(data) : noop()
      }
    >
      {rowContent}
    </TreeRowContextMenu>
  );
}

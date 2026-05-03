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
 * Plan 03-07 hook points (the chassis-only design boundary for Plan
 * 03-06's deliverable):
 *   - data-tree-row=<id-or-path>   on the row root, for context-menu
 *                                  scoping + drag-handle targeting
 *   - data-tree-row-kind=          "folder" | "note", for menu-item set
 *   - data-tree-row-label          on the label span, for hover-tooltip
 *                                  enrichment if needed in 03-07
 *   - data-tree-row-kebab          on the kebab button — Plan 03-07 wires
 *                                  the actual Radix DropdownMenu trigger
 *
 * XSS hardening: this file MUST NOT use the React inner-HTML escape
 * hatch (the `dangerously...` prop). Labels are rendered as React text
 * content, which escapes by default — even a malicious title with
 * <script> renders as plain text. The vitest case
 * `TestRow_DoesNotUseDangerously...InnerHTML` enforces this — the
 * forbidden token is split across the test source so this comment can
 * mention the family of escape hatches without tripping the gate.
 */
import type { CSSProperties } from "react";
import type { NodeApi } from "react-arborist";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  MoreHorizontal,
} from "lucide-react";

import { useTreeStore } from "../lib/useTreeStore";

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
}

const muted: CSSProperties = { color: "var(--color-muted)", flexShrink: 0 };

export function TreeRow({ node, style, onSelectNote }: TreeRowProps) {
  const activeNoteId = useTreeStore((s) => s.activeNoteId);
  const data = node.data;
  const isFolder = data.kind === "folder";
  const isActive = !isFolder && activeNoteId === data.id;
  // 16px indent step (UI-SPEC §Layout). 16px base padding-left + 16px per
  // depth level. Verified by TestRow_IndentScalesWithLevel.
  const indent = 16 + 16 * node.level;

  const handleClick = () => {
    if (isFolder) {
      node.toggle();
    } else {
      onSelectNote(data.id);
      useTreeStore.getState().setActiveNote(data.id);
    }
  };

  const activeBackground = isActive
    ? "color-mix(in srgb, var(--color-accent) 8%, transparent)"
    : undefined;

  const dataTreeRowValue = isFolder ? data.path : data.id;

  return (
    <div
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
      role="treeitem"
      aria-expanded={isFolder ? node.isOpen : undefined}
      aria-current={isActive ? "page" : undefined}
      tabIndex={-1}
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
      {/* Label — React text-content escape is the XSS gate; no
          inner-HTML escape hatch anywhere in this file. */}
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
      {/* Kebab — visible on hover or focus-within. Placeholder slot:
          Plan 03-07 wires the Radix DropdownMenu trigger here. */}
      <button
        type="button"
        data-tree-row-kebab
        aria-label="Row menu"
        onClick={(e) => {
          e.stopPropagation();
          // Plan 03-07 wires the actual menu open. Until then, no-op.
        }}
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
    </div>
  );
}

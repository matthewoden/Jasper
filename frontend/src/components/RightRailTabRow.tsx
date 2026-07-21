/**
 * RightRailTabRow — icon-only Outline / Linked mentions / Tags tab row +
 * collapse control for the right rail's tab-row shell (Phase 30 TAGS-01,
 * D-01/D-02; collapse control added in 30-13 gap closure per owner UAT).
 *
 * Mirrors SidebarTabRow.tsx: same tabBase, same active/hover color-mix
 * formula, same 8px gap, same space-between + collapse-button pattern —
 * but horizontally mirrored. The left rail has its icon tabs at the app
 * edge (left) and its collapse control at the inner edge (right); this row
 * puts its icon tabs at the app edge (right) and its collapse control at
 * the inner edge (left), producing a mirror image of the left rail.
 *
 * Active tab is driven by the persisted rightPanel field (useTreeStore
 * rightPanel slice, hydrated by useWorkspace — Plan 01). Clicking a tab
 * calls useWorkspace().setRightPanel(value), which optimistically updates
 * the slice and persists to workspace.json.
 *
 * The collapse control reuses the existing backlinksRailExpanded slice
 * (useTreeStore) — already persisted to localStorage by App.tsx — so no
 * new persistence or workspace.json field is introduced. Reopening a
 * collapsed rail (260721-cjt: the rail unmounts to 0 width when collapsed)
 * is handled by the rightmost pane's own tab-bar toggle, not by this row.
 *
 * Also exports RightRailSubHeader — a small in-panel sub-header used below
 * the tab row by the active panel (ported from SectionHeader.tsx with the
 * chevron/onToggle/aria-expanded collapse machinery removed, since panels
 * are no longer independently collapsible in the tab-row model).
 */
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { List, Link2, Tag, PanelRight } from "lucide-react";
import { useTreeStore, type RightPanelTab } from "../lib/useTreeStore";
import { useWorkspace } from "../lib/useWorkspace";

const tabBase: CSSProperties = {
  width: 30,
  height: 30,
  padding: 0,
  border: "none",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 6,
};

interface TabButtonProps {
  ariaLabel: string;
  title: string;
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
}

function TabButton({
  ariaLabel,
  title,
  active,
  onClick,
  icon,
}: TabButtonProps): React.JSX.Element {
  const [hovering, setHovering] = useState(false);
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        ...tabBase,
        color: active ? "var(--color-accent)" : "var(--color-muted)",
        background: active
          ? "color-mix(in srgb, var(--color-accent) 14%, transparent)"
          : hovering
            ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
            : "transparent",
      }}
    >
      {icon}
    </button>
  );
}

const collapseButtonBase: CSSProperties = {
  width: 30,
  height: 30,
  padding: 0,
  background: "transparent",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 6,
};

export function RightRailTabRow(): React.JSX.Element {
  const rightPanel = useTreeStore((s) => s.rightPanel);
  const setBacklinksRailExpanded = useTreeStore((s) => s.setBacklinksRailExpanded);
  const { setRightPanel } = useWorkspace();
  const [collapseHovering, setCollapseHovering] = useState(false);

  const selectPanel = (panel: RightPanelTab) => {
    void setRightPanel(panel);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
      }}
      data-testid="right-rail-tab-row"
    >
      <button
        type="button"
        aria-label="Collapse panels"
        title="Collapse panels"
        onClick={() => setBacklinksRailExpanded(false)}
        onMouseEnter={() => setCollapseHovering(true)}
        onMouseLeave={() => setCollapseHovering(false)}
        style={{
          ...collapseButtonBase,
          background: collapseHovering
            ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
            : "transparent",
        }}
      >
        <PanelRight size={16} aria-hidden="true" />
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <TabButton
          ariaLabel="Outline"
          title="Outline"
          active={rightPanel === "outline"}
          onClick={() => selectPanel("outline")}
          icon={<List size={16} aria-hidden="true" />}
        />
        <TabButton
          ariaLabel="Linked mentions"
          title="Linked mentions"
          active={rightPanel === "backlinks"}
          onClick={() => selectPanel("backlinks")}
          icon={<Link2 size={16} aria-hidden="true" />}
        />
        <TabButton
          ariaLabel="Tags"
          title="Tags"
          active={rightPanel === "tags"}
          onClick={() => selectPanel("tags")}
          icon={<Tag size={16} aria-hidden="true" />}
        />
      </div>
    </div>
  );
}

/** Ported verbatim from SectionHeader.tsx — chevron/onToggle/aria-expanded removed. */
const subHeaderStyle: CSSProperties = {
  height: 32,
  // 24px matches the outline content's text line — rail-wide inset so the
  // icon tabs, sub-header title, and panel content share one alignment edge.
  padding: "0 24px",
  background: "var(--color-surface)",
  display: "flex",
  alignItems: "center",
  gap: 8,
  border: "none",
  borderBottom: "1px solid var(--color-border)",
  width: "100%",
  flexShrink: 0,
};

const subHeaderLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-muted)",
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  lineHeight: 1.4,
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** Ported verbatim from SectionHeader.tsx's countPillStyle. */
const subHeaderCountPillStyle: CSSProperties = {
  padding: "0 6px",
  height: 18,
  minWidth: 18,
  borderRadius: 9,
  background: "color-mix(in srgb, var(--color-fg) 10%, transparent)",
  color: "var(--color-muted)",
  fontSize: 11,
  fontWeight: 600,
  lineHeight: "18px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

export interface RightRailSubHeaderProps {
  title: string;
  /** Omitted entirely when undefined — e.g. Outline may render without a count. */
  count?: number;
}

/** Non-clickable, always-visible in-panel sub-header for the active right-rail panel. */
export function RightRailSubHeader({ title, count }: RightRailSubHeaderProps) {
  return (
    <div style={subHeaderStyle}>
      <span style={subHeaderLabelStyle}>{title}</span>
      {count !== undefined && <span style={subHeaderCountPillStyle}>{count}</span>}
    </div>
  );
}

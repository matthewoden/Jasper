/**
 * RightRailTabRow — icon-only Outline / Linked mentions / Tags tab row for
 * the right rail's tab-row shell (Phase 30 TAGS-01, D-01/D-02).
 *
 * Mirrors SidebarTabRow.tsx pixel-for-pixel (same tabBase, same
 * active/hover color-mix formula, same 8px gap) — no collapse button here;
 * rail collapse is a separate affordance from this row (D-05).
 *
 * Active tab is driven by the persisted rightPanel field (useTreeStore
 * rightPanel slice, hydrated by useWorkspace — Plan 01). Clicking a tab
 * calls useWorkspace().setRightPanel(value), which optimistically updates
 * the slice and persists to workspace.json.
 *
 * Also exports RightRailSubHeader — a small in-panel sub-header used below
 * the tab row by the active panel (ported from SectionHeader.tsx with the
 * chevron/onToggle/aria-expanded collapse machinery removed, since panels
 * are no longer independently collapsible in the tab-row model).
 */
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { List, Link2, Tag } from "lucide-react";
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

export function RightRailTabRow(): React.JSX.Element {
  const rightPanel = useTreeStore((s) => s.rightPanel);
  const { setRightPanel } = useWorkspace();

  const selectPanel = (panel: RightPanelTab) => {
    void setRightPanel(panel);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
      data-testid="right-rail-tab-row"
    >
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
  );
}

/** Ported verbatim from SectionHeader.tsx — chevron/onToggle/aria-expanded removed. */
const subHeaderStyle: CSSProperties = {
  height: 32,
  padding: "0 12px",
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

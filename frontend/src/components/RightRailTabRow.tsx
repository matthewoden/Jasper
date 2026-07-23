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
          // Optical alignment: pull the button left so the 16px glyph's left
          // edge (7px inside the 30px box) sits on the rail's 24px title line.
          marginLeft: -7,
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

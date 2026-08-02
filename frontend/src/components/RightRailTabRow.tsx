/**
 * RightRailTabRow mirrors SidebarTabRow horizontally: icon tabs at the app edge
 * (right here, left there) and the collapse control at the inner edge, so the
 * two rails read as a mirrored pair.
 *
 * The active tab is the persisted rightPanel field; clicking writes through
 * useWorkspace, which updates optimistically and persists.
 */
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { List, Link2, Tag, PanelRight } from "lucide-react";
import { useTreeStore, type RightPanelTab } from "../lib/useTreeStore";
import { useWorkspace } from "../lib/useWorkspace";
import { Tooltip } from "./Tooltip";

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
    <Tooltip label={title} side="bottom">
      <button
        type="button"
        aria-label={ariaLabel}
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
    </Tooltip>
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
      <Tooltip label="Collapse panels" side="bottom">
        <button
          type="button"
          aria-label="Collapse panels"
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
      </Tooltip>
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

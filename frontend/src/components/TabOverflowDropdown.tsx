/**
 * TabOverflowDropdown — pinned to the strip's right edge and ALWAYS rendered,
 * even with no overflow. The menu lists every open tab in order, not just the
 * hidden ones.
 */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type React from "react";
import { Tooltip } from "./Tooltip";

export interface TabEntry {
  id: string;
  title: string;
  isActive: boolean;
}

export interface TabOverflowDropdownProps {
  /** EVERY open tab, in tab order — not just the ones hidden by overflow (item 7). */
  tabs: TabEntry[];
  onSelectTab: (id: string) => void;
}

// Square 24×24 hit area (NotesSortMenu.triggerButtonStyle treatment,
// copied verbatim) — it was 28×24 (not square, owner complaint).
//
// The owner also wants L/R breathing room plus
// vertical centering in the tab-strip row (see TabStrip.tsx's
// newTabButtonStyle comment for the full rationale — this REVERSES the prior
// bottom-pin/co-centering contract with TabPill's close-× and the new-tab +).
// `alignSelf:"center"` overrides the strip's `alignItems:"flex-end"` so this
// trigger centers in the full 40px row; `marginLeft`/`marginRight` give the
// requested horizontal padding.
const triggerButtonStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  padding: 4,
  margin: "0 4px",
  alignSelf: "center",
  background: "transparent",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
  // the trigger is now always rendered, so it must
  // never shrink away even when the visible-tabs flex child grows to fill
  // the strip — it stays pinned at the strip's right edge.
  flexShrink: 0,
};

const popoverStyle: React.CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: 4,
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
  zIndex: 100,
  width: 240,
  maxHeight: 360,
  overflowY: "auto",
};

const itemStyle: React.CSSProperties = {
  height: 32,
  padding: "0 12px",
  borderRadius: 4,
  display: "flex",
  alignItems: "center",
  cursor: "pointer",
  color: "var(--color-fg)",
  fontSize: 12,
  outline: "none",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const activeItemStyle: React.CSSProperties = {
  ...itemStyle,
  background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
};

export function TabOverflowDropdown({
  tabs,
  onSelectTab,
}: TabOverflowDropdownProps): React.JSX.Element {
  const [hovering, setHovering] = useState(false);

  return (
    <DropdownMenu.Root>
      <Tooltip label="Show all tabs">
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Show all tabs"
            style={{
              ...triggerButtonStyle,
              background: hovering
                ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
                : "transparent",
            }}
            onMouseEnter={() => setHovering(true)}
            onMouseLeave={() => setHovering(false)}
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} style={popoverStyle}>
          {tabs.map((tab) => (
            <DropdownMenu.Item
              key={tab.id}
              style={tab.isActive ? activeItemStyle : itemStyle}
              aria-label={tab.isActive ? `${tab.title} (active)` : undefined}
              onSelect={() => onSelectTab(tab.id)}
            >
              {tab.title}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

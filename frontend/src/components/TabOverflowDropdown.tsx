/**
 * TabOverflowDropdown — Radix DropdownMenu listing tabs hidden by the strip's
 * overflow. Selecting an item activates that tab (TAB-07). The active row gets the
 * shared accent-12% tint. Mirrors PanelSelectorDropdown's Root/Trigger/Portal/Content.
 */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type React from "react";

export interface HiddenTab {
  id: string;
  title: string;
  isActive: boolean;
}

export interface TabOverflowDropdownProps {
  hiddenTabs: HiddenTab[];
  onSelectTab: (id: string) => void;
}

const triggerButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  padding: 4,
  background: "transparent",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
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
  hiddenTabs,
  onSelectTab,
}: TabOverflowDropdownProps): React.JSX.Element {
  const [hovering, setHovering] = useState(false);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Show hidden tabs"
          title="Show hidden tabs"
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
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} style={popoverStyle}>
          {hiddenTabs.map((tab) => (
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

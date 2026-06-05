/**
 * PanelSelectorDropdown — Phase 6.6, Plan 08 (UX-CHROME-01 / D-03 / D-34).
 *
 * UAT follow-up 2026-05-12: removed the checkbox/indicator model. The dropdown
 * is now an action menu: clicking an item opens that panel (sets the selector
 * true) AND ensures the rail is expanded. Whether a panel is open is visually
 * apparent from the rail itself, so no checkbox state is shown in the menu.
 *
 * Radix DropdownMenu with two Items (Tags, Backlinks) that write the
 * useTreeStore.panelSelector slice. Multi-select via repeated selection — each
 * item adds to the open set. Closing is done via the per-panel × button on the
 * panel header (which triggers rail auto-collapse via RightRail's useEffect
 * when no panel remains visible).
 *
 * Mounted in TopBar (Plan 09). Replaces the rail-level toggle button (Plan 11
 * removes that). Zero new npm dependencies — @radix-ui/react-dropdown-menu is
 * already in package.json from Phase 3/4 tree row menus + SettingsMenu.
 *
 * Template: SettingsMenu.tsx (RadioItem → Item variant).
 * Z-index: 100 (clears TopBar's zIndex: 10).
 */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Layout } from "lucide-react";
import { useState } from "react";
import type React from "react";
import { useTreeStore } from "../lib/useTreeStore";

const triggerButtonStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  padding: 4,
  background: "transparent",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
};

const popoverStyle: React.CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: 4,
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
  zIndex: 100,
  minWidth: 160,
};

const itemStyle: React.CSSProperties = {
  height: 32,
  padding: "0 12px",
  borderRadius: 4,
  display: "flex",
  alignItems: "center",
  cursor: "pointer",
  color: "var(--color-fg)",
  fontSize: 14,
  outline: "none",
};

function openPanel(panel: "tags" | "backlinks"): void {
  const s = useTreeStore.getState();
  s.setPanelSelector({ [panel]: true } as Partial<{
    tags: boolean;
    backlinks: boolean;
  }>);
  if (!s.backlinksRailExpanded) {
    s.setBacklinksRailExpanded(true);
  }
}

export function PanelSelectorDropdown(): React.JSX.Element {
  const [hovering, setHovering] = useState(false);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Open panel"
          title="Open panel"
          style={{
            ...triggerButtonStyle,
            background: hovering
              ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
              : "transparent",
          }}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
        >
          <Layout size={16} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} style={popoverStyle}>
          <DropdownMenu.Item
            style={itemStyle}
            data-testid="panel-selector-tags"
            onSelect={() => openPanel("tags")}
          >
            Tags
          </DropdownMenu.Item>
          <DropdownMenu.Item
            style={itemStyle}
            data-testid="panel-selector-backlinks"
            onSelect={() => openPanel("backlinks")}
          >
            Backlinks
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

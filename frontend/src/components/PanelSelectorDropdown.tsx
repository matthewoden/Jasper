/**
 * PanelSelectorDropdown — Phase 6.6, Plan 08 (UX-CHROME-01 / D-03 / D-34).
 *
 * Radix DropdownMenu with two CheckboxItems (Tags, Backlinks) that read and
 * write useTreeStore.panelSelector. Multi-select: both panels can be open
 * simultaneously.
 *
 * Mounted in TopBar (Plan 09). Replaces the rail-level toggle button (Plan 11
 * removes that). Zero new npm dependencies — @radix-ui/react-dropdown-menu is
 * already in package.json from Phase 3/4 tree row menus + SettingsMenu.
 *
 * Template: SettingsMenu.tsx (RadioItem → CheckboxItem variant).
 * Z-index: 100 (clears TopBar's zIndex: 10).
 */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Layout } from "lucide-react";
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
  padding: 8,
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
  zIndex: 100,
  minWidth: 160,
};

const checkboxItemStyle: React.CSSProperties = {
  height: 32,
  padding: "8px",
  borderRadius: 4,
  display: "flex",
  alignItems: "center",
  gap: 8,
  cursor: "pointer",
  color: "var(--color-fg)",
  fontSize: 14,
  outline: "none",
};

const itemIndicatorWrapStyle: React.CSSProperties = {
  width: 14,
  height: 14,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

export function PanelSelectorDropdown(): React.JSX.Element {
  const panelSelector = useTreeStore((s) => s.panelSelector);
  const setPanelSelector = useTreeStore((s) => s.setPanelSelector);
  const [hovering, setHovering] = useState(false);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Select panels"
          title="Select panels"
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
          <DropdownMenu.CheckboxItem
            checked={panelSelector.tags}
            onCheckedChange={(v) => setPanelSelector({ tags: Boolean(v) })}
            style={checkboxItemStyle}
            data-testid="panel-selector-tags"
          >
            <span style={itemIndicatorWrapStyle}>
              <DropdownMenu.ItemIndicator>
                <Check
                  size={14}
                  style={{ color: "var(--color-accent)" }}
                  aria-hidden="true"
                />
              </DropdownMenu.ItemIndicator>
            </span>
            <span style={{ flex: 1 }}>Tags</span>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            checked={panelSelector.backlinks}
            onCheckedChange={(v) => setPanelSelector({ backlinks: Boolean(v) })}
            style={checkboxItemStyle}
            data-testid="panel-selector-backlinks"
          >
            <span style={itemIndicatorWrapStyle}>
              <DropdownMenu.ItemIndicator>
                <Check
                  size={14}
                  style={{ color: "var(--color-accent)" }}
                  aria-hidden="true"
                />
              </DropdownMenu.ItemIndicator>
            </span>
            <span style={{ flex: 1 }}>Backlinks</span>
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

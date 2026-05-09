/**
 * SettingsMenu — Phase 5 / Plan 05-10. The 3-dot popover at the END
 * of SidebarToolbar containing the theme RadioGroup. UI-SPEC Surface 2.
 *
 * D-14 LOCKED structure: Radix DropdownMenu (D-42 default) with one
 * item — Theme RadioGroup with Dark + Light options.
 *
 * Copy is LOCKED (UI-SPEC §Copywriting Contract):
 *   Trigger aria-label/title:  "Settings"
 *   Group label:               "Theme"
 *   Dark radio label:          "Dark"
 *   Light radio label:         "Light"
 *   Combined aria-labels:      "Theme: Dark", "Theme: Light"
 */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Settings, Sun, Moon, Check } from "lucide-react";
import type React from "react";
import { useTheme } from "../lib/useTheme";

const buttonBase: React.CSSProperties = {
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
  width: 240,
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: 8,
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
  zIndex: 50,
};

const groupLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-muted)",
  padding: "4px 8px",
  letterSpacing: "0.05em",
};

const radioItemStyle: React.CSSProperties = {
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

export function SettingsMenu() {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          data-testid="settings-menu-trigger"
          style={buttonBase}
        >
          <Settings size={16} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          style={popoverStyle}
          data-testid="settings-menu-content"
        >
          <DropdownMenu.Label style={groupLabelStyle}>Theme</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={theme}
            onValueChange={(v) => {
              if (v === "dark" || v === "light") void setTheme(v);
            }}
          >
            <DropdownMenu.RadioItem
              value="dark"
              aria-label="Theme: Dark"
              style={radioItemStyle}
              data-testid="settings-theme-dark"
            >
              <Moon size={14} aria-hidden="true" />
              <span style={{ flex: 1 }}>Dark</span>
              <DropdownMenu.ItemIndicator>
                <Check size={14} aria-hidden="true" />
              </DropdownMenu.ItemIndicator>
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem
              value="light"
              aria-label="Theme: Light"
              style={radioItemStyle}
              data-testid="settings-theme-light"
            >
              <Sun size={14} aria-hidden="true" />
              <span style={{ flex: 1 }}>Light</span>
              <DropdownMenu.ItemIndicator>
                <Check size={14} aria-hidden="true" />
              </DropdownMenu.ItemIndicator>
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

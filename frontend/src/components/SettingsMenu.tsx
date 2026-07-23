/**
 * SettingsMenu — trigger wrapper that opens SettingsDialog on click.
 *
 * Plain button (not Dialog.Trigger asChild) to keep E2E selectors stable
 * and avoid Radix asChild composition subtleties.
 * Trigger contract (E2E-stable): aria-label="Settings"
 * data-testid="settings-menu-trigger". Native title= migrated to the shared
 * Tooltip (D-07); aria-label kept for E2E stability.
 */
import { useState } from "react";
import { Settings } from "lucide-react";
import type React from "react";
import { SettingsDialog } from "./SettingsDialog";
import { Tooltip } from "./Tooltip";

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

export function SettingsMenu() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip label="Settings" side="bottom">
        <button
          type="button"
          aria-label="Settings"
          data-testid="settings-menu-trigger"
          style={buttonBase}
          onClick={() => setOpen(true)}
        >
          <Settings size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <SettingsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

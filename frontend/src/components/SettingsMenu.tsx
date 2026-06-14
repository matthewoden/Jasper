/**
 * SettingsMenu — trigger wrapper that opens SettingsDialog on click.
 *
 * Plain button (not Dialog.Trigger asChild) to keep E2E selectors stable
 * and avoid Radix asChild composition subtleties.
 * Trigger contract (E2E-stable): aria-label="Settings" title="Settings"
 * data-testid="settings-menu-trigger".
 */
import { useState } from "react";
import { Settings } from "lucide-react";
import type React from "react";
import { SettingsDialog } from "./SettingsDialog";

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
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        data-testid="settings-menu-trigger"
        style={buttonBase}
        onClick={() => setOpen(true)}
      >
        <Settings size={16} aria-hidden="true" />
      </button>
      <SettingsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

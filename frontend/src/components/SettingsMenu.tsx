/**
 * SettingsMenu — Phase 11 Plan 03 repurpose.
 *
 * Previously: Radix DropdownMenu with theme RadioGroup (Phase 5 / Plan 05-10).
 * Now: Trigger wrapper that opens SettingsDialog on click.
 *
 * CONVENTIONS §"Orphaned code is a design signal" — file is NOT deleted,
 * it is repurposed. The trigger button contract is PRESERVED:
 *   aria-label="Settings"  title="Settings"  data-testid="settings-menu-trigger"
 *
 * Theme switching moves into the APPEARANCE section of SettingsDialog.
 * StatusBar.tsx mounts <SettingsMenu /> — no change to StatusBar needed.
 *
 * Pattern: RESEARCH.md Pattern 3 — plain button + onClick (not Dialog.Trigger
 * asChild) to keep the E2E selector stable and avoid Radix asChild subtleties.
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

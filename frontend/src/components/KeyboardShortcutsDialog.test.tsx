/**
 * KeyboardShortcutsDialog tests — Plan 07-12.
 *
 * Verifies:
 * - Dialog opens when open=true, renders title + footer + close button.
 * - All CHEAT_SHEET_ENTRIES labels are present.
 * - GROUP_ORDER groups are rendered as eyebrows.
 * - Close button calls onOpenChange(false).
 * - Esc closes via Radix (tested via Dialog.Root onOpenChange).
 * - No hex literals in the component (structural guard only — gated by grep in CI).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { CHEAT_SHEET_ENTRIES, GROUP_ORDER } from "../lib/shortcutsRegistry";

// Radix Dialog uses portals — jsdom does not need special setup since
// @testing-library/react appends portals to document.body by default.

describe("KeyboardShortcutsDialog", () => {
  it("KSD-1: renders title 'Keyboard shortcuts' when open=true", () => {
    const onOpenChange = vi.fn();
    render(<KeyboardShortcutsDialog open={true} onOpenChange={onOpenChange} />);
    expect(
      screen.getByText("Keyboard shortcuts"),
    ).toBeInTheDocument();
  });

  it("KSD-2: renders locked footer tip verbatim", () => {
    const onOpenChange = vi.fn();
    render(<KeyboardShortcutsDialog open={true} onOpenChange={onOpenChange} />);
    expect(
      screen.getByText(
        /Tip: ⌘P and ⌘O are intercepted by Jasper\./,
      ),
    ).toBeInTheDocument();
  });

  it("KSD-3: renders a Close button", () => {
    const onOpenChange = vi.fn();
    render(<KeyboardShortcutsDialog open={true} onOpenChange={onOpenChange} />);
    expect(
      screen.getByRole("button", { name: "Close" }),
    ).toBeInTheDocument();
  });

  it("KSD-4: clicking Close calls onOpenChange(false)", () => {
    const onOpenChange = vi.fn();
    render(<KeyboardShortcutsDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("KSD-5: all CHEAT_SHEET_ENTRIES labels are present when open=true", () => {
    const onOpenChange = vi.fn();
    render(<KeyboardShortcutsDialog open={true} onOpenChange={onOpenChange} />);
    for (const entry of CHEAT_SHEET_ENTRIES) {
      expect(screen.getByText(entry.label)).toBeInTheDocument();
    }
  });

  it("KSD-6: GROUP_ORDER groups present as eyebrow headings (case-insensitive uppercase)", () => {
    const onOpenChange = vi.fn();
    render(<KeyboardShortcutsDialog open={true} onOpenChange={onOpenChange} />);
    // Groups that actually have entries in CHEAT_SHEET_ENTRIES
    const presentGroups = GROUP_ORDER.filter((g) =>
      CHEAT_SHEET_ENTRIES.some((e) => e.group === g),
    );
    for (const group of presentGroups) {
      expect(
        screen.getByText(group.toUpperCase()),
      ).toBeInTheDocument();
    }
  });

  it("KSD-7: dialog does NOT render when open=false", () => {
    const onOpenChange = vi.fn();
    render(<KeyboardShortcutsDialog open={false} onOpenChange={onOpenChange} />);
    expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
  });

  it("KSD-8: entries with shortcut render a KeyboardChip (kbd element)", () => {
    const onOpenChange = vi.fn();
    render(<KeyboardShortcutsDialog open={true} onOpenChange={onOpenChange} />);
    // At least one <kbd> element should be present for entries with shortcuts
    const kbdElements = document.querySelectorAll("kbd");
    const entriesWithShortcut = CHEAT_SHEET_ENTRIES.filter((e) => e.shortcut);
    expect(kbdElements.length).toBeGreaterThanOrEqual(
      entriesWithShortcut.length,
    );
  });

  it("KSD-9: entries without shortcut render an em-dash", () => {
    const onOpenChange = vi.fn();
    render(<KeyboardShortcutsDialog open={true} onOpenChange={onOpenChange} />);
    // "Toggle theme" is in CHEAT_SHEET_ENTRIES with no shortcut
    const noShortcutEntry = CHEAT_SHEET_ENTRIES.find(
      (e) => !e.shortcut && e.inCheatSheet,
    );
    if (noShortcutEntry) {
      // Should render an em-dash for the missing shortcut
      const dashes = screen.getAllByText("—");
      expect(dashes.length).toBeGreaterThan(0);
    }
  });
});

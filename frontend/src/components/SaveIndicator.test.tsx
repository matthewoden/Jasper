/**
 * SaveIndicator render tests. Per 01-UI-SPEC.md §"Save Indicator State Machine"
 * we lock copy strings + tooltip phrasing + ARIA semantics here so the contract
 * survives the Phase 5 CodeMirror swap.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SaveState } from "../lib/saveStateMachine";
import { SaveIndicator } from "./SaveIndicator";

describe("<SaveIndicator />", () => {
  it("C1: idle renders an empty 24px-tall status row (no icon, no text)", () => {
    const { container } = render(<SaveIndicator state={{ status: "idle" }} />);

    const row = container.querySelector('[role="status"]');
    expect(row).not.toBeNull();
    // The 24px height comes from the h-6 utility — assert by class name so
    // we don't rely on jsdom computing layout.
    expect(row?.className).toContain("h-6");
    // ARIA live region present for screen readers.
    expect(row).toHaveAttribute("aria-live", "polite");
    // No label, no icon — the row is visually empty in idle.
    expect(row?.textContent ?? "").toBe("");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("C2: saving renders Loader2 spinner + 'Saving…' label + tooltip", () => {
    const state: SaveState = {
      status: "saving",
      startedAt: new Date(2025, 0, 1, 10, 0, 0),
    };
    render(<SaveIndicator state={state} />);

    const row = screen.getByRole("status");
    expect(row).toHaveAttribute("title", "Saving your note");
    expect(row).toHaveAttribute("aria-live", "polite");
    expect(row).toHaveTextContent("Saving…");
    // Loader2 lucide icon: lucide ships <svg class="lucide lucide-loader-2 ...">.
    const icon = row.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("class") ?? "").toMatch(/animate-spin/);
    expect(icon?.getAttribute("class") ?? "").toMatch(/text-accent/);
  });

  it("C3: saved renders Check icon + 'Saved' label + 'Saved at HH:MM:SS' tooltip in 24h time", () => {
    const savedAt = new Date(2025, 0, 1, 14, 30, 5);
    render(<SaveIndicator state={{ status: "saved", savedAt }} />);

    const row = screen.getByRole("status");
    expect(row).toHaveAttribute("title", "Saved at 14:30:05");
    expect(row).toHaveTextContent("Saved");
    const icon = row.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("class") ?? "").toMatch(/text-success/);
  });

  it("C4: error renders AlertCircle + 'Save failed' label + ⌘S recovery tooltip", () => {
    render(
      <SaveIndicator state={{ status: "error", error: "boom" }} />,
    );

    const row = screen.getByRole("status");
    expect(row).toHaveAttribute(
      "title",
      "Save failed — your edit is still in the editor. Press ⌘S to retry.",
    );
    expect(row).toHaveTextContent("Save failed");
    const icon = row.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("class") ?? "").toMatch(/text-destructive/);
  });

  it("C5: every state exposes role=status and aria-live=polite", () => {
    const states: SaveState[] = [
      { status: "idle" },
      { status: "saving", startedAt: new Date() },
      { status: "saved", savedAt: new Date() },
      { status: "error", error: "x" },
    ];

    for (const state of states) {
      const { container, unmount } = render(<SaveIndicator state={state} />);
      const row = container.querySelector('[role="status"]');
      expect(row).not.toBeNull();
      expect(row).toHaveAttribute("aria-live", "polite");
      unmount();
    }
  });

  it("pads single-digit clock components to two digits", () => {
    const savedAt = new Date(2025, 0, 1, 1, 2, 3);
    render(<SaveIndicator state={{ status: "saved", savedAt }} />);
    expect(screen.getByRole("status")).toHaveAttribute(
      "title",
      "Saved at 01:02:03",
    );
  });
});

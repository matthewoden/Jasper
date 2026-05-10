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
  it("C1: idle renders nothing (no layout space, no icon, no text)", () => {
    // 2026-05-10 — SaveIndicator switched from a fixed 24px row to an
    // absolute-positioned overlay. Idle now returns null so the editor
    // pane content can flow from y=0 (closing the visible blank gap
    // above the first content line that the user couldn't scroll past).
    // The other states still render role="status" with aria-live=polite
    // — covered by C2/C3/C4 + C5 below.
    const { container } = render(<SaveIndicator state={{ status: "idle" }} />);
    expect(container.querySelector('[role="status"]')).toBeNull();
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

  it("C5: every NON-IDLE state exposes role=status and aria-live=polite", () => {
    // Idle is the no-render case (covered by C1) — only the active
    // states (saving / saved / error) render the live region.
    const states: SaveState[] = [
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

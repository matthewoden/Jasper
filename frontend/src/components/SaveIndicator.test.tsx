/**
 * SaveIndicator render tests. Per 01-UI-SPEC.md §"Save Indicator State Machine"
 * we lock copy strings + tooltip phrasing + ARIA semantics here so the contract
 * survives the Phase 5 CodeMirror swap.
 *
 * Plan 07-37 (UAT-3 N9): SaveIndicator additionally accepts an optional
 * `onClick` prop. When provided it renders as a `<button>` (clickable hybrid
 * SaveIndicator + manual-refresh control mounted in TopBar's right cluster).
 * When omitted it preserves the legacy read-only behavior used by older
 * mounting points.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

// ─────────────────────────────────────────────────────────────────────────────
// Plan 07-37 (UAT-3 N9) — SaveIndicator-as-button hybrid.
//
// When `onClick` is provided, SaveIndicator becomes a clickable <button>:
//   - icon-only render (no text label) sized for TopBar right cluster
//   - state-driven icon: idle/synced=Cloud, saving=Loader2 (spin), saved=Check,
//     error=AlertCircle, paused=CloudOff
//   - tooltip = state copy + " — click to refresh"
//   - disabled while a save is in flight (status === "saving") so rapid clicks
//     don't issue overlapping reindex POSTs (T-37-01)
// ─────────────────────────────────────────────────────────────────────────────
describe("<SaveIndicator /> — onClick (Plan 07-37 SaveIndicator-as-button)", () => {
  it("SI-BTN-1: with onClick prop, renders as a <button>", () => {
    const handler = vi.fn();
    const { container } = render(
      <SaveIndicator state={{ status: "idle" }} onClick={handler} />,
    );
    const btn = container.querySelector("button[data-save-state]");
    expect(btn).not.toBeNull();
    expect(btn?.tagName.toLowerCase()).toBe("button");
  });

  it("SI-BTN-2: WITHOUT onClick prop, idle still returns null (legacy read-only behavior preserved)", () => {
    const { container } = render(<SaveIndicator state={{ status: "idle" }} />);
    // Legacy behavior: no role=status, no svg.
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector("button[data-save-state]")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("SI-BTN-3: idle (button mode) renders Cloud icon (visible always-present button)", () => {
    const { container } = render(
      <SaveIndicator state={{ status: "idle" }} onClick={vi.fn()} />,
    );
    const btn = container.querySelector("button[data-save-state='idle']");
    expect(btn).not.toBeNull();
    const svg = btn?.querySelector("svg");
    expect(svg).not.toBeNull();
    // lucide ships <svg class="lucide lucide-cloud ...">
    expect(svg?.getAttribute("class") ?? "").toMatch(/lucide-cloud(?!-off)/);
  });

  it("SI-BTN-4: saving renders Loader2 with animate-spin class", () => {
    const { container } = render(
      <SaveIndicator
        state={{ status: "saving", startedAt: new Date() }}
        onClick={vi.fn()}
      />,
    );
    const btn = container.querySelector("button[data-save-state='saving']");
    expect(btn).not.toBeNull();
    const svg = btn?.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class") ?? "").toMatch(/animate-spin/);
    expect(svg?.getAttribute("class") ?? "").toMatch(/lucide-loader/);
  });

  it("SI-BTN-5: saved renders Check icon", () => {
    const { container } = render(
      <SaveIndicator
        state={{ status: "saved", savedAt: new Date(2025, 0, 1, 14, 30, 5) }}
        onClick={vi.fn()}
      />,
    );
    const btn = container.querySelector("button[data-save-state='saved']");
    expect(btn).not.toBeNull();
    const svg = btn?.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class") ?? "").toMatch(/lucide-check/);
  });

  it("SI-BTN-6: error renders AlertCircle icon", () => {
    const { container } = render(
      <SaveIndicator
        state={{ status: "error", error: "boom" }}
        onClick={vi.fn()}
      />,
    );
    const btn = container.querySelector("button[data-save-state='error']");
    expect(btn).not.toBeNull();
    const svg = btn?.querySelector("svg");
    expect(svg).not.toBeNull();
    // lucide AlertCircle ships as `lucide-circle-alert` in modern lucide-react;
    // accept either historical name to stay version-tolerant.
    expect(svg?.getAttribute("class") ?? "").toMatch(/lucide-(alert-circle|circle-alert)/);
  });

  it("SI-BTN-7: paused renders CloudOff icon", () => {
    const { container } = render(
      <SaveIndicator state={{ status: "paused" }} onClick={vi.fn()} />,
    );
    const btn = container.querySelector("button[data-save-state='paused']");
    expect(btn).not.toBeNull();
    const svg = btn?.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class") ?? "").toMatch(/lucide-cloud-off/);
  });

  it("SI-BTN-8: tooltip is state copy + ' — click to refresh' when onClick is set", () => {
    const { container } = render(
      <SaveIndicator state={{ status: "idle" }} onClick={vi.fn()} />,
    );
    const btn = container.querySelector("button[data-save-state]");
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("title") ?? "").toMatch(/click to refresh/i);
    expect(btn?.getAttribute("aria-label") ?? "").toMatch(/click to refresh/i);
  });

  it("SI-BTN-9a: button is disabled while status === 'saving' (DoS guard T-37-01)", () => {
    const { container } = render(
      <SaveIndicator
        state={{ status: "saving", startedAt: new Date() }}
        onClick={vi.fn()}
      />,
    );
    const btn = container.querySelector(
      "button[data-save-state='saving']",
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn?.disabled).toBe(true);
  });

  it("SI-BTN-9b: button is enabled in non-saving states (idle, saved, error, paused)", () => {
    const states: SaveState[] = [
      { status: "idle" },
      { status: "saved", savedAt: new Date() },
      { status: "error", error: "boom" },
      { status: "paused" },
    ];
    for (const state of states) {
      const { container, unmount } = render(
        <SaveIndicator state={state} onClick={vi.fn()} />,
      );
      const btn = container.querySelector(
        "button[data-save-state]",
      ) as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      expect(btn?.disabled).toBe(false);
      unmount();
    }
  });

  it("SI-BTN-10: clicking the button calls the onClick handler", () => {
    const handler = vi.fn();
    const { container } = render(
      <SaveIndicator state={{ status: "idle" }} onClick={handler} />,
    );
    const btn = container.querySelector(
      "button[data-save-state]",
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("SI-BTN-11: clicking while disabled (saving) does NOT call onClick", () => {
    const handler = vi.fn();
    const { container } = render(
      <SaveIndicator
        state={{ status: "saving", startedAt: new Date() }}
        onClick={handler}
      />,
    );
    const btn = container.querySelector(
      "button[data-save-state='saving']",
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    // disabled button: click handler does not fire
    expect(handler).not.toHaveBeenCalled();
  });
});

/**
 * SaveIndicator render tests — locks copy strings, tooltip phrasing, and ARIA semantics.
 *
 * When onClick is provided the component renders as a clickable button (hybrid
 * save indicator + manual-refresh control). Without onClick it renders a
 * read-only status overlay.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type React from "react";

import type { SaveState } from "../lib/saveStateMachine";
import { SaveIndicator } from "./SaveIndicator";
import { TooltipProvider } from "./Tooltip";

describe("<SaveIndicator />", () => {
  it("C1: idle renders nothing (no layout space, no icon, no text)", () => {
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


// Button mode always renders inside the shared Tooltip system (Phase 31 UAT
// #1) — every render in this describe block needs a TooltipProvider
// ancestor or Radix throws.
function renderButton(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("<SaveIndicator /> — onClick (Plan 07-37 SaveIndicator-as-button)", () => {
  it("SI-BTN-1: with onClick prop, renders as a <button>", () => {
    const handler = vi.fn();
    const { container } = renderButton(
      <SaveIndicator state={{ status: "idle" }} onClick={handler} />,
    );
    const btn = container.querySelector("button[data-save-state]");
    expect(btn).not.toBeNull();
    expect(btn?.tagName.toLowerCase()).toBe("button");
  });

  it("SI-BTN-2: WITHOUT onClick prop, idle still returns null (legacy read-only behavior preserved)", () => {
    const { container } = render(<SaveIndicator state={{ status: "idle" }} />);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector("button[data-save-state]")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("SI-BTN-3: idle (button mode) renders Cloud icon (visible always-present button)", () => {
    const { container } = renderButton(
      <SaveIndicator state={{ status: "idle" }} onClick={vi.fn()} />,
    );
    const btn = container.querySelector("button[data-save-state='idle']");
    expect(btn).not.toBeNull();
    const svg = btn?.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class") ?? "").toMatch(/lucide-cloud(?!-off)/);
  });

  it("SI-BTN-4: saving renders Loader2 with animate-spin class", () => {
    const { container } = renderButton(
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
    const { container } = renderButton(
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
    const { container } = renderButton(
      <SaveIndicator
        state={{ status: "error", error: "boom" }}
        onClick={vi.fn()}
      />,
    );
    const btn = container.querySelector("button[data-save-state='error']");
    expect(btn).not.toBeNull();
    const svg = btn?.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class") ?? "").toMatch(/lucide-(alert-circle|circle-alert)/);
  });

  it("SI-BTN-7: paused renders CloudOff icon", () => {
    const { container } = renderButton(
      <SaveIndicator state={{ status: "paused" }} onClick={vi.fn()} />,
    );
    const btn = container.querySelector("button[data-save-state='paused']");
    expect(btn).not.toBeNull();
    const svg = btn?.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class") ?? "").toMatch(/lucide-cloud-off/);
  });

  it("SI-BTN-8: aria-label is state copy + ' — click to refresh'; the tooltip (shared Tooltip, Phase 31 UAT #1) shows the same copy, no native title", () => {
    renderButton(<SaveIndicator state={{ status: "idle" }} onClick={vi.fn()} />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("aria-label") ?? "").toMatch(/click to refresh/i);
    expect(btn).not.toHaveAttribute("title");
    fireEvent.focus(btn);
    expect(screen.getByText(/click to refresh/i)).toBeInTheDocument();
  });

  it("SI-BTN-9a: button is disabled while status === 'saving' (DoS guard T-37-01)", () => {
    const { container } = renderButton(
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
      const { container, unmount } = renderButton(
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
    const { container } = renderButton(
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
    const { container } = renderButton(
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
    expect(handler).not.toHaveBeenCalled();
  });
});

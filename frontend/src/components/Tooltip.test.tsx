/**
 * Tooltip tests (D-06..D-09) — shared wrapper + provider.
 *
 * Radix opens the tooltip immediately on trigger `focus` (no delayDuration
 * applied to keyboard/focus triggering, only pointer hover) — fireEvent.focus
 * is used to reveal Content deterministically without fake timers.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Tooltip, TooltipProvider } from "./Tooltip";

describe("<Tooltip />", () => {
  it("renders the label and, when provided, a muted shortcut after focusing the trigger", () => {
    render(
      <TooltipProvider>
        <Tooltip label="Sort notes" shortcut="⌘O">
          <button aria-label="Sort notes">icon</button>
        </Tooltip>
      </TooltipProvider>,
    );

    fireEvent.focus(screen.getByRole("button", { name: "Sort notes" }));

    expect(screen.getByText("Sort notes")).toBeInTheDocument();
    expect(screen.getByText("⌘O")).toBeInTheDocument();
  });

  it("does not render a shortcut span when none is provided", () => {
    render(
      <TooltipProvider>
        <Tooltip label="Collapse panels">
          <button aria-label="Collapse panels">icon</button>
        </Tooltip>
      </TooltipProvider>,
    );

    fireEvent.focus(screen.getByRole("button", { name: "Collapse panels" }));

    expect(screen.getByText("Collapse panels")).toBeInTheDocument();
    expect(screen.queryByText("⌘O")).not.toBeInTheDocument();
  });

  it("passes through the wrapped trigger's aria-label (accessible via getByRole)", () => {
    render(
      <TooltipProvider>
        <Tooltip label="Sort notes">
          <button aria-label="Sort notes">icon</button>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Sort notes" }),
    ).toBeInTheDocument();
  });

  it("does not render a native title attribute on the trigger", () => {
    render(
      <TooltipProvider>
        <Tooltip label="Sort notes">
          <button aria-label="Sort notes">icon</button>
        </Tooltip>
      </TooltipProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Sort notes" });
    expect(trigger).not.toHaveAttribute("title");
  });

  it("renders the rich `content` prop in place of label+shortcut when provided", () => {
    render(
      <TooltipProvider>
        <Tooltip content={<span>Created Jul 22, 2026 at 3:04 PM</span>}>
          <button aria-label="Note date">icon</button>
        </Tooltip>
      </TooltipProvider>,
    );

    fireEvent.focus(screen.getByRole("button", { name: "Note date" }));

    expect(
      screen.getByText("Created Jul 22, 2026 at 3:04 PM"),
    ).toBeInTheDocument();
  });
});

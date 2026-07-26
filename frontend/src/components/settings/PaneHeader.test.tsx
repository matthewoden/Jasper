import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../Tooltip";
import { PaneHeader } from "./PaneHeader";

function renderHeader(props: Partial<React.ComponentProps<typeof PaneHeader>> = {}) {
  const onReset = vi.fn();
  const onClose = vi.fn();
  render(
    <TooltipProvider>
      <PaneHeader
        title="Editor"
        subtitle="Writing and autosave"
        showReset={true}
        onReset={onReset}
        onClose={onClose}
        {...props}
      />
    </TooltipProvider>,
  );
  return { onReset, onClose };
}

describe("PaneHeader", () => {
  it("renders Reset and calls onReset on click when showReset is true", () => {
    const { onReset } = renderHeader({ showReset: true });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("renders no Reset button when showReset is false (About pane, D-08)", () => {
    renderHeader({ showReset: false });
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("exposes the accessible name 'Close settings' and calls onClose", () => {
    const { onClose } = renderHeader();
    const closeButton = screen.getByRole("button", { name: "Close settings" });
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders a 56px, flexShrink:0 header row", () => {
    renderHeader();
    const header = screen.getByRole("button", { name: "Close settings" }).closest("div[style]")
      ?.parentElement;
    expect(header).toHaveStyle({ height: "56px", flexShrink: "0" });
  });
});

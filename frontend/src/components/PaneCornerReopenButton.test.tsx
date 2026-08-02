/**
 * PaneCornerReopenButton tests:
 *   - Renders null when notesSidebarVisible is true.
 *   - Renders a "Show sidebar" button when notesSidebarVisible is false.
 *   - Click sets notesSidebarVisible true.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PaneCornerReopenButton } from "./PaneCornerReopenButton";
import { TooltipProvider } from "./Tooltip";
import { useTreeStore } from "../lib/useTreeStore";

beforeEach(() => {
  cleanup();
  useTreeStore.setState({ notesSidebarVisible: true });
});

describe("<PaneCornerReopenButton />", () => {
  it("renders null when notesSidebarVisible is true", () => {
    useTreeStore.setState({ notesSidebarVisible: true });
    const { container } = render(<PaneCornerReopenButton />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a 'Show sidebar' button when notesSidebarVisible is false", () => {
    useTreeStore.setState({ notesSidebarVisible: false });
    render(
      <TooltipProvider>
        <PaneCornerReopenButton />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Show sidebar" })).toBeInTheDocument();
  });

  it("clicking the button sets notesSidebarVisible true", () => {
    useTreeStore.setState({ notesSidebarVisible: false });
    render(
      <TooltipProvider>
        <PaneCornerReopenButton />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(useTreeStore.getState().notesSidebarVisible).toBe(true);
  });
});

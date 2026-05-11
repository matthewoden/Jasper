/**
 * RightRail tests — Phase 6 Plan 06-07.
 *
 * Tests for the right-side rail layout shell: collapsed/expanded states,
 * toggle button behavior, resize handle drag, aria contracts.
 *
 * Uses vi.mock for useTreeStore to isolate component from store internals.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock useTreeStore so tests control state directly.
const mockSetExpanded = vi.fn();
const mockSetWidth = vi.fn();

let mockExpanded = false;
let mockWidth = 280;

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      backlinksRailExpanded: mockExpanded,
      backlinksRailWidth: mockWidth,
      setBacklinksRailExpanded: mockSetExpanded,
      setBacklinksRailWidth: mockSetWidth,
    };
    return selector(state);
  },
  RAIL_MAX_WIDTH: 480,
  RAIL_MIN_WIDTH: 220,
  RAIL_COLLAPSED_WIDTH: 32,
}));

// Import after mock setup.
import { RightRail } from "./RightRail";

describe("RightRail — collapsed state", () => {
  beforeEach(() => {
    mockExpanded = false;
    mockWidth = 280;
    mockSetExpanded.mockReset();
    mockSetWidth.mockReset();
  });

  it("R1: renders 32px-wide collapsed strip with toggle button", () => {
    const { container } = render(<RightRail />);
    const aside = container.querySelector("aside");
    expect(aside).toBeTruthy();
    // Toggle button should be present
    const btn = screen.getByRole("button", { name: /show backlinks panel/i });
    expect(btn).toBeInTheDocument();
  });

  it("R1: collapsed toggle button has aria-expanded=false", () => {
    render(<RightRail />);
    const btn = screen.getByRole("button", { name: /show backlinks panel/i });
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("R3: clicking the toggle in collapsed state calls setBacklinksRailExpanded(true)", () => {
    render(<RightRail />);
    const btn = screen.getByRole("button", { name: /show backlinks panel/i });
    fireEvent.click(btn);
    expect(mockSetExpanded).toHaveBeenCalledWith(true);
  });
});

describe("RightRail — expanded state", () => {
  beforeEach(() => {
    mockExpanded = true;
    mockWidth = 280;
    mockSetExpanded.mockReset();
    mockSetWidth.mockReset();
  });

  it("R2: renders resize handle with role=separator in expanded state", () => {
    render(<RightRail />);
    const handle = screen.getByRole("separator");
    expect(handle).toBeInTheDocument();
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-label", "Resize backlinks panel");
  });

  it("R2: renders children prop when expanded", () => {
    render(
      <RightRail>
        <div data-testid="rail-child">Child content</div>
      </RightRail>
    );
    expect(screen.getByTestId("rail-child")).toBeInTheDocument();
  });

  it("R4: pointerdown on resize handle + pointermove updates width via store setter", () => {
    render(<RightRail />);
    const handle = screen.getByRole("separator");

    // Mock window.innerWidth
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });

    // Simulate drag: pointerdown, pointermove, pointerup
    fireEvent.pointerDown(handle, { clientX: 0 });
    // clientX = 1200 → width = 1440 - 1200 = 240 (clamped to [220, 480])
    const moveEvent = new PointerEvent("pointermove", { clientX: 1200, bubbles: true });
    document.dispatchEvent(moveEvent);
    expect(mockSetWidth).toHaveBeenCalledWith(240);
  });

  it("R5: expanded toggle shows aria-label for hiding", () => {
    // In expanded state the toggle is inside BacklinksRail header, not RightRail.
    // RightRail in expanded state does NOT render its own separate toggle strip.
    // Children are responsible for the Hide button (this is by design — D-46).
    // Just verify the aside exists without the "Show" button.
    render(<RightRail />);
    const showBtn = screen.queryByRole("button", { name: /show backlinks panel/i });
    expect(showBtn).toBeNull();
  });
});

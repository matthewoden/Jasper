/**
 * BacklinksRail tests — Phase 6 Plan 06-07.
 *
 * Tests for the backlinks panel chrome: header render, empty state, hide button.
 * Data wiring (useBacklinks) is Plan 06-11; this plan ships chrome-only.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSetExpanded = vi.fn();

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setBacklinksRailExpanded: mockSetExpanded,
    };
    return selector(state);
  },
}));

import { BacklinksRail } from "./BacklinksRail";

describe("BacklinksRail — chrome", () => {
  beforeEach(() => {
    mockSetExpanded.mockReset();
  });

  it("B1: renders 'Linked from' header", () => {
    render(<BacklinksRail noteId={null} />);
    expect(screen.getByText(/linked from/i)).toBeInTheDocument();
  });

  it("B3: renders region with aria-label 'Notes that link to this note'", () => {
    render(<BacklinksRail noteId={null} />);
    const region = screen.getByRole("region", { name: /notes that link to this note/i });
    expect(region).toBeInTheDocument();
  });

  it("B2: renders empty state copy when body is empty (noteId=null)", () => {
    render(<BacklinksRail noteId={null} />);
    expect(screen.getByText(/no notes link here yet/i)).toBeInTheDocument();
  });

  it("B1: clicking Hide button calls setBacklinksRailExpanded(false)", () => {
    render(<BacklinksRail noteId={null} />);
    const hideBtn = screen.getByRole("button", { name: /hide backlinks panel/i });
    fireEvent.click(hideBtn);
    expect(mockSetExpanded).toHaveBeenCalledWith(false);
  });
});

/**
 * RightRailTabRow tests — three icon tabs (Outline/Linked mentions/Tags)
 * mirroring SidebarTabRow.tsx (Phase 30 TAGS-01, D-01/D-02).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

let mockRightPanel: "outline" | "backlinks" | "tags" = "outline";
const mockSetRightPanel = vi.fn();
const mockSetBacklinksRailExpanded = vi.fn();

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      rightPanel: mockRightPanel,
      setBacklinksRailExpanded: mockSetBacklinksRailExpanded,
    }),
}));

vi.mock("../lib/useWorkspace", () => ({
  useWorkspace: () => ({
    notesSort: "name-asc",
    searchSort: "relevance",
    rightPanel: mockRightPanel,
    setNotesSort: vi.fn(),
    setSearchSort: vi.fn(),
    setRightPanel: mockSetRightPanel,
  }),
}));

import { RightRailTabRow } from "./RightRailTabRow";

beforeEach(() => {
  mockRightPanel = "outline";
  mockSetRightPanel.mockReset();
  mockSetBacklinksRailExpanded.mockReset();
});

describe("RightRailTabRow", () => {
  it("renders exactly three icon tabs plus a collapse control", () => {
    render(<RightRailTabRow />);
    expect(screen.getByTitle("Outline")).toBeInTheDocument();
    expect(screen.getByTitle("Linked mentions")).toBeInTheDocument();
    expect(screen.getByTitle("Tags")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  it("renders a collapse control with aria-label 'Collapse panels' that calls setBacklinksRailExpanded(false)", () => {
    render(<RightRailTabRow />);
    const collapseButton = screen.getByLabelText("Collapse panels");
    expect(collapseButton).toBeInTheDocument();
    fireEvent.click(collapseButton);
    expect(mockSetBacklinksRailExpanded).toHaveBeenCalledWith(false);
  });

  it("clicking a tab calls setRightPanel with the matching value", () => {
    render(<RightRailTabRow />);
    fireEvent.click(screen.getByTitle("Linked mentions"));
    expect(mockSetRightPanel).toHaveBeenCalledWith("backlinks");

    fireEvent.click(screen.getByTitle("Tags"));
    expect(mockSetRightPanel).toHaveBeenCalledWith("tags");

    fireEvent.click(screen.getByTitle("Outline"));
    expect(mockSetRightPanel).toHaveBeenCalledWith("outline");
  });

  it("active tab (per rightPanel slice) uses the accent color + accent-14% tint background", () => {
    mockRightPanel = "backlinks";
    render(<RightRailTabRow />);
    const active = screen.getByTitle("Linked mentions");
    expect(active).toHaveStyle({ color: "var(--color-accent)" });
    expect(active.getAttribute("style")).toContain(
      "color-mix(in srgb, var(--color-accent) 14%, transparent)",
    );
  });

  it("inactive tabs use the muted color", () => {
    mockRightPanel = "backlinks";
    render(<RightRailTabRow />);
    const inactive = screen.getByTitle("Outline");
    expect(inactive).toHaveStyle({ color: "var(--color-muted)" });
  });

  it("tab button style matches SidebarTabRow's tabBase (30x30, radius 6)", () => {
    render(<RightRailTabRow />);
    const tab = screen.getByTitle("Outline");
    expect(tab).toHaveStyle({ width: "30px", height: "30px", borderRadius: "6px" });
  });
});

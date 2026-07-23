/**
 * RightRailTabRow tests — three icon tabs (Outline/Linked mentions/Tags)
 * mirroring SidebarTabRow.tsx (Phase 30 TAGS-01, D-01/D-02).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { TooltipProvider } from "./Tooltip";

function renderTabRow(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

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
    renderTabRow(<RightRailTabRow />);
    expect(screen.getByRole("button", { name: "Outline" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Linked mentions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tags" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  it("renders a collapse control with aria-label 'Collapse panels' that calls setBacklinksRailExpanded(false)", () => {
    renderTabRow(<RightRailTabRow />);
    const collapseButton = screen.getByLabelText("Collapse panels");
    expect(collapseButton).toBeInTheDocument();
    fireEvent.click(collapseButton);
    expect(mockSetBacklinksRailExpanded).toHaveBeenCalledWith(false);
  });

  it("clicking a tab calls setRightPanel with the matching value", () => {
    renderTabRow(<RightRailTabRow />);
    fireEvent.click(screen.getByRole("button", { name: "Linked mentions" }));
    expect(mockSetRightPanel).toHaveBeenCalledWith("backlinks");

    fireEvent.click(screen.getByRole("button", { name: "Tags" }));
    expect(mockSetRightPanel).toHaveBeenCalledWith("tags");

    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(mockSetRightPanel).toHaveBeenCalledWith("outline");
  });

  it("active tab (per rightPanel slice) uses the accent color + accent-14% tint background", () => {
    mockRightPanel = "backlinks";
    renderTabRow(<RightRailTabRow />);
    const active = screen.getByRole("button", { name: "Linked mentions" });
    expect(active).toHaveStyle({ color: "var(--color-accent)" });
    expect(active.getAttribute("style")).toContain(
      "color-mix(in srgb, var(--color-accent) 14%, transparent)",
    );
  });

  it("inactive tabs use the muted color", () => {
    mockRightPanel = "backlinks";
    renderTabRow(<RightRailTabRow />);
    const inactive = screen.getByRole("button", { name: "Outline" });
    expect(inactive).toHaveStyle({ color: "var(--color-muted)" });
  });

  it("tab button style matches SidebarTabRow's tabBase (30x30, radius 6)", () => {
    renderTabRow(<RightRailTabRow />);
    const tab = screen.getByRole("button", { name: "Outline" });
    expect(tab).toHaveStyle({ width: "30px", height: "30px", borderRadius: "6px" });
  });
});

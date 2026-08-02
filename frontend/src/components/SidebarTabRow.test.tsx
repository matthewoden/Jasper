/**
 * SidebarTabRow tests — 3 icon tabs (Notes/Search/Bookmarks) + collapse
 * control (NAV-01/NAV-03).
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSetSidebarPanel = vi.fn();
const mockSetNotesSidebarVisible = vi.fn();

let mockSidebarPanel: "notes" | "search" | "bookmarks" = "notes";

vi.mock("../lib/useTreeStore", () => {
  const state = () => ({
    sidebarPanel: mockSidebarPanel,
    setSidebarPanel: mockSetSidebarPanel,
    setNotesSidebarVisible: mockSetNotesSidebarVisible,
  });
  const useTreeStore = (selector: (s: unknown) => unknown) => selector(state());
  useTreeStore.getState = () => state();
  return { useTreeStore };
});

import { SidebarTabRow } from "./SidebarTabRow";
import { TooltipProvider } from "./Tooltip";

function renderTabRow() {
  return render(
    <TooltipProvider>
      <SidebarTabRow />
    </TooltipProvider>,
  );
}

describe("SidebarTabRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSidebarPanel = "notes";
  });

  it("renders exactly 3 tab buttons with the correct aria-labels", () => {
    renderTabRow();
    expect(screen.getByRole("button", { name: "Notes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bookmarks" })).toBeInTheDocument();
  });

  it("renders a collapse button", () => {
    renderTabRow();
    expect(
      screen.getByRole("button", { name: "Collapse sidebar" }),
    ).toBeInTheDocument();
  });

  it("clicking the Notes tab calls setSidebarPanel('notes') + reopens the sidebar", () => {
    mockSidebarPanel = "search";
    renderTabRow();
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(mockSetSidebarPanel).toHaveBeenCalledWith("notes");
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(true);
  });

  it("clicking the Search tab calls setSidebarPanel('search') + reopens the sidebar", () => {
    renderTabRow();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(mockSetSidebarPanel).toHaveBeenCalledWith("search");
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(true);
  });

  it("clicking the Bookmarks tab sets sidebarPanel === 'bookmarks' + reopens the sidebar", () => {
    renderTabRow();
    fireEvent.click(screen.getByRole("button", { name: "Bookmarks" }));
    expect(mockSetSidebarPanel).toHaveBeenCalledWith("bookmarks");
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(true);
  });

  it("the active tab (Notes, default) has the accent treatment", () => {
    mockSidebarPanel = "notes";
    renderTabRow();
    const btn = screen.getByRole("button", { name: "Notes" });
    expect(btn.style.color).toBe("var(--color-accent)");
    expect(btn.style.background).toBe(
      "color-mix(in srgb, var(--color-accent) 14%, transparent)",
    );
  });

  it("inactive tabs are muted, not accented", () => {
    mockSidebarPanel = "notes";
    renderTabRow();
    const search = screen.getByRole("button", { name: "Search" });
    const bookmarks = screen.getByRole("button", { name: "Bookmarks" });
    expect(search.style.color).toBe("var(--color-muted)");
    expect(bookmarks.style.color).toBe("var(--color-muted)");
  });

  it("clicking the collapse button sets notesSidebarVisible === false", () => {
    renderTabRow();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(false);
    expect(mockSetSidebarPanel).not.toHaveBeenCalled();
  });

  it("the Bookmarks tab is active when sidebarPanel === 'bookmarks'", () => {
    mockSidebarPanel = "bookmarks";
    renderTabRow();
    const btn = screen.getByRole("button", { name: "Bookmarks" });
    expect(btn.style.color).toBe("var(--color-accent)");
  });
});

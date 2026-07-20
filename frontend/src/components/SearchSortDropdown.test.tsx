/**
 * SearchSortDropdown tests — UI-SPEC D-15.
 *
 * Uses the controlled `open` prop (same pattern as TreeRowMenu.test.tsx) to
 * mount Radix DropdownMenu.Content immediately for assertions, avoiding
 * jsdom pointer-event flakiness on the trigger.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SearchSortDropdown } from "./SearchSortDropdown";

describe("<SearchSortDropdown />", () => {
  it("renders exactly three D-15 labeled items", () => {
    render(<SearchSortDropdown value="relevance" onSelect={vi.fn()} open={true} />);
    expect(screen.getByText("Relevance")).toBeInTheDocument();
    expect(screen.getByText("Modified (new → old)")).toBeInTheDocument();
    expect(screen.getByText("Created (new → old)")).toBeInTheDocument();
  });

  it("shows a trailing Check only on the active item (relevance)", () => {
    render(<SearchSortDropdown value="relevance" onSelect={vi.fn()} open={true} />);
    const relevanceItem = screen.getByText("Relevance").closest('[role="menuitem"]');
    const modifiedItem = screen.getByText("Modified (new → old)").closest('[role="menuitem"]');
    expect(relevanceItem?.querySelector("svg")).toBeInTheDocument();
    expect(modifiedItem?.querySelector("svg")).not.toBeInTheDocument();
  });

  it("shows a trailing Check only on the active item (modified)", () => {
    render(<SearchSortDropdown value="modified" onSelect={vi.fn()} open={true} />);
    const relevanceItem = screen.getByText("Relevance").closest('[role="menuitem"]');
    const modifiedItem = screen.getByText("Modified (new → old)").closest('[role="menuitem"]');
    expect(modifiedItem?.querySelector("svg")).toBeInTheDocument();
    expect(relevanceItem?.querySelector("svg")).not.toBeInTheDocument();
  });

  it("fires onSelect with 'modified' when that item is clicked", () => {
    const onSelect = vi.fn();
    render(<SearchSortDropdown value="relevance" onSelect={onSelect} open={true} />);
    fireEvent.click(screen.getByText("Modified (new → old)"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("modified");
  });

  it("fires onSelect with 'created' when that item is clicked", () => {
    const onSelect = vi.fn();
    render(<SearchSortDropdown value="relevance" onSelect={onSelect} open={true} />);
    fireEvent.click(screen.getByText("Created (new → old)"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("created");
  });

  it("fires onSelect with 'relevance' when that item is clicked", () => {
    const onSelect = vi.fn();
    render(<SearchSortDropdown value="created" onSelect={onSelect} open={true} />);
    fireEvent.click(screen.getByText("Relevance"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("relevance");
  });

  it("renders the trigger with the current selection as text", () => {
    render(<SearchSortDropdown value="created" onSelect={vi.fn()} />);
    expect(screen.getByLabelText("Sort search results")).toHaveTextContent("Created");
  });
});

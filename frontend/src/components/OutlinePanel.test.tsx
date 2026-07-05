/**
 * OutlinePanel.test.tsx — vitest suite for the Outline panel component.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { OutlinePanel } from "./OutlinePanel";
import { useOutlineStore } from "../lib/useOutlineStore";
import type { HeadingInfo } from "../editor/outlineExtract";

function setHeadings(headings: HeadingInfo[]) {
  useOutlineStore.setState({ outlineHeadings: headings });
}

describe("OutlinePanel", () => {
  beforeEach(() => {
    useOutlineStore.setState({ outlineHeadings: [], scrollToHeading: null });
  });

  it("shows the two-line 'No headings' empty state when there are no headings", () => {
    render(<OutlinePanel />);
    expect(screen.getByText("No headings")).toBeInTheDocument();
    expect(
      screen.getByText("Add a heading to see it here."),
    ).toBeInTheDocument();
  });

  it("renders rows with computed indent for levels 1 and 3", () => {
    setHeadings([
      { level: 1, text: "Top", line: 1, from: 0 },
      { level: 3, text: "Deep", line: 3, from: 10 },
    ]);
    render(<OutlinePanel />);
    const topRow = screen.getByLabelText("Go to heading: Top");
    const deepRow = screen.getByLabelText("Go to heading: Deep");
    expect(topRow).toHaveStyle({ paddingLeft: "8px" });
    expect(deepRow).toHaveStyle({ paddingLeft: "32px" });
  });

  it("calls scrollToHeading with the heading's from offset when a row is clicked", () => {
    const scrollFn = vi.fn();
    useOutlineStore.setState({
      outlineHeadings: [{ level: 2, text: "Section", line: 5, from: 42 }],
      scrollToHeading: scrollFn,
    });
    render(<OutlinePanel />);
    fireEvent.click(screen.getByLabelText("Go to heading: Section"));
    expect(scrollFn).toHaveBeenCalledWith(42);
  });

  it("folds a parent's child rows on chevron click, and leaves render an aligned spacer", () => {
    setHeadings([
      { level: 1, text: "Parent", line: 1, from: 0 },
      { level: 2, text: "Child", line: 3, from: 10 },
      { level: 1, text: "Sibling", line: 5, from: 20 },
    ]);
    render(<OutlinePanel />);

    // Parent row has a fold chevron; leaf rows (Child, Sibling) do not.
    expect(
      screen.getByLabelText('Collapse "Parent" section'),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Collapse "Child" section'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Go to heading: Child")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Collapse "Parent" section'));

    expect(
      screen.queryByLabelText("Go to heading: Child"),
    ).not.toBeInTheDocument();
    // Sibling is NOT a descendant of Parent (same level) — stays visible.
    expect(
      screen.getByLabelText("Go to heading: Sibling"),
    ).toBeInTheDocument();

    expect(
      screen.getByLabelText('Expand "Parent" section'),
    ).toBeInTheDocument();
  });
});

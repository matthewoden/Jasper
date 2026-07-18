/**
 * FindReplaceBar tests (P26, WS-09/D-01..D-04).
 *
 * Coverage: find-only vs replace mode, match-count pluralization, toggle
 * click emits onToggle with the correct kind and flips data-active, Esc
 * fires onClose, all four aria-labels are present.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { FindReplaceBar, type MatchCount } from "./FindReplaceBar";

const baseProps = {
  query: "",
  replaceText: "",
  caseSensitive: false,
  regexp: false,
  wholeWord: false,
  onQueryChange: vi.fn(),
  onReplaceTextChange: vi.fn(),
  onToggle: vi.fn(),
  onFindNext: vi.fn(),
  onFindPrev: vi.fn(),
  onReplaceNext: vi.fn(),
  onReplaceAll: vi.fn(),
  onClose: vi.fn(),
};

function renderBar(overrides: Partial<React.ComponentProps<typeof FindReplaceBar>> = {}) {
  const matchCount: MatchCount = overrides.matchCount ?? { current: 0, total: 0 };
  return render(
    <FindReplaceBar
      mode="find"
      {...baseProps}
      {...overrides}
      matchCount={matchCount}
    />,
  );
}

describe("<FindReplaceBar />", () => {
  it("renders the Find row and NO Replace row in find mode", () => {
    renderBar({ mode: "find" });
    expect(screen.getByPlaceholderText("Find")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Replace with")).toBeNull();
    expect(screen.queryByText("Replace")).toBeNull();
    expect(screen.queryByText("Replace All")).toBeNull();
  });

  it("renders the Replace row in replace mode", () => {
    renderBar({ mode: "replace" });
    expect(screen.getByPlaceholderText("Find")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Replace with")).toBeInTheDocument();
    expect(screen.getByText("Replace")).toBeInTheDocument();
    expect(screen.getByText("Replace All")).toBeInTheDocument();
  });

  it("match-count pluralization: 0 matches / 1 match / N matches", () => {
    const { rerender } = render(
      <FindReplaceBar mode="find" {...baseProps} matchCount={{ current: 0, total: 0 }} />,
    );
    expect(screen.getByTestId("find-match-count")).toHaveTextContent("0 matches");

    rerender(<FindReplaceBar mode="find" {...baseProps} matchCount={{ current: 1, total: 1 }} />);
    expect(screen.getByTestId("find-match-count")).toHaveTextContent("1 match");

    rerender(<FindReplaceBar mode="find" {...baseProps} matchCount={{ current: 1, total: 3 }} />);
    expect(screen.getByTestId("find-match-count")).toHaveTextContent("3 matches");
  });

  it("clicking a toggle fires onToggle with the right kind", () => {
    const onToggle = vi.fn();
    renderBar({ onToggle });

    fireEvent.click(screen.getByLabelText("Match case"));
    expect(onToggle).toHaveBeenCalledWith("caseSensitive");

    fireEvent.click(screen.getByLabelText("Use regular expression"));
    expect(onToggle).toHaveBeenCalledWith("regexp");

    fireEvent.click(screen.getByLabelText("Match whole word"));
    expect(onToggle).toHaveBeenCalledWith("wholeWord");
  });

  it("an active toggle carries data-active", () => {
    renderBar({ caseSensitive: true });
    expect(screen.getByLabelText("Match case")).toHaveAttribute("data-active", "true");
    expect(screen.getByLabelText("Use regular expression")).not.toHaveAttribute("data-active");
  });

  it("Esc fires onClose", () => {
    const onClose = vi.fn();
    renderBar({ onClose });
    fireEvent.keyDown(screen.getByPlaceholderText("Find"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the close (X) button fires onClose", () => {
    const onClose = vi.fn();
    renderBar({ onClose });
    fireEvent.click(screen.getByLabelText("Close find bar"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("all four aria-labels are present", () => {
    renderBar();
    expect(screen.getByLabelText("Close find bar")).toBeInTheDocument();
    expect(screen.getByLabelText("Match case")).toBeInTheDocument();
    expect(screen.getByLabelText("Use regular expression")).toBeInTheDocument();
    expect(screen.getByLabelText("Match whole word")).toBeInTheDocument();
  });

  it("Enter in the find input fires onFindNext", () => {
    const onFindNext = vi.fn();
    renderBar({ onFindNext });
    fireEvent.keyDown(screen.getByPlaceholderText("Find"), { key: "Enter" });
    expect(onFindNext).toHaveBeenCalledTimes(1);
  });

  it("Shift+Enter in the find input fires onFindPrev", () => {
    const onFindPrev = vi.fn();
    renderBar({ onFindPrev });
    fireEvent.keyDown(screen.getByPlaceholderText("Find"), { key: "Enter", shiftKey: true });
    expect(onFindPrev).toHaveBeenCalledTimes(1);
  });

  it("typing in the find input fires onQueryChange", () => {
    const onQueryChange = vi.fn();
    renderBar({ onQueryChange });
    fireEvent.change(screen.getByPlaceholderText("Find"), { target: { value: "hello" } });
    expect(onQueryChange).toHaveBeenCalledWith("hello");
  });

  it("clicking Replace All fires onReplaceAll", () => {
    const onReplaceAll = vi.fn();
    renderBar({ mode: "replace", onReplaceAll });
    fireEvent.click(screen.getByText("Replace All"));
    expect(onReplaceAll).toHaveBeenCalledTimes(1);
  });

  it("clicking Replace fires onReplaceNext", () => {
    const onReplaceNext = vi.fn();
    renderBar({ mode: "replace", onReplaceNext });
    fireEvent.click(screen.getByText("Replace"));
    expect(onReplaceNext).toHaveBeenCalledTimes(1);
  });
});

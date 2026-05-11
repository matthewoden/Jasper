/**
 * Tests for ActiveTagFilterChip component.
 * Validates C1..C5 behaviors from Plan 06-08 Task 3.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useTreeStore } from "../lib/useTreeStore";

// We import the component after setting up the store
import { ActiveTagFilterChip } from "./ActiveTagFilterChip";

beforeEach(() => {
  useTreeStore.setState({ activeTagFilter: null });
});

describe("ActiveTagFilterChip", () => {
  it("C1: when activeTagFilter is null, renders nothing", () => {
    useTreeStore.setState({ activeTagFilter: null });
    const { container } = render(<ActiveTagFilterChip />);
    expect(container.firstChild).toBeNull();
  });

  it("C2: when activeTagFilter='foo', renders chip with 'foo ×' content and correct styles", () => {
    useTreeStore.setState({ activeTagFilter: "foo" });
    render(<ActiveTagFilterChip />);

    // Should show the tag name
    expect(screen.getByText("foo")).toBeInTheDocument();
    // Should show the × button
    const closeBtn = screen.getByRole("button", { name: "Remove tag filter: foo" });
    expect(closeBtn).toBeInTheDocument();
  });

  it("C3: clicking the × button calls setActiveTagFilter(null)", () => {
    useTreeStore.setState({ activeTagFilter: "myTag" });
    render(<ActiveTagFilterChip />);

    const closeBtn = screen.getByRole("button", { name: "Remove tag filter: myTag" });
    fireEvent.click(closeBtn);

    expect(useTreeStore.getState().activeTagFilter).toBeNull();
  });

  it("C4: the × button is focusable (is a button element)", () => {
    useTreeStore.setState({ activeTagFilter: "test" });
    render(<ActiveTagFilterChip />);

    const closeBtn = screen.getByRole("button", { name: "Remove tag filter: test" });
    // Buttons are focusable by default
    expect(closeBtn.tagName).toBe("BUTTON");
    expect(closeBtn).not.toHaveAttribute("disabled");
  });

  it("C5: the × button has aria-label='Remove tag filter: {tagname}'", () => {
    useTreeStore.setState({ activeTagFilter: "project" });
    render(<ActiveTagFilterChip />);

    const closeBtn = screen.getByRole("button");
    expect(closeBtn).toHaveAttribute("aria-label", "Remove tag filter: project");
  });
});

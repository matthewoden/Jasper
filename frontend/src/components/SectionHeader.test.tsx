/**
 * Tests for SectionHeader — unified whole-row-clickable collapse header
 * (RSIDE-01/RSIDE-02).
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { SectionHeader } from "./SectionHeader";

describe("SectionHeader", () => {
  it("Test 1: renders the label text", () => {
    render(
      <SectionHeader
        title="Outline"
        expanded={true}
        onToggle={() => {}}
        ariaCollapsedLabel="Expand Outline"
        ariaExpandedLabel="Collapse Outline"
      />,
    );
    expect(screen.getByText("Outline")).toBeInTheDocument();
  });

  it("Test 2: clicking the header calls onToggle", () => {
    const onToggle = vi.fn();
    render(
      <SectionHeader
        title="Outline"
        expanded={true}
        onToggle={onToggle}
        ariaCollapsedLabel="Expand Outline"
        ariaExpandedLabel="Collapse Outline"
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("Test 3: chevron swaps between ChevronDown (expanded) and ChevronRight (collapsed)", () => {
    const { rerender, container } = render(
      <SectionHeader
        title="Outline"
        expanded={true}
        onToggle={() => {}}
        ariaCollapsedLabel="Expand Outline"
        ariaExpandedLabel="Collapse Outline"
      />,
    );
    expect(container.querySelector(".lucide-chevron-down")).not.toBeNull();
    expect(container.querySelector(".lucide-chevron-right")).toBeNull();

    rerender(
      <SectionHeader
        title="Outline"
        expanded={false}
        onToggle={() => {}}
        ariaCollapsedLabel="Expand Outline"
        ariaExpandedLabel="Collapse Outline"
      />,
    );
    expect(container.querySelector(".lucide-chevron-right")).not.toBeNull();
    expect(container.querySelector(".lucide-chevron-down")).toBeNull();
  });

  it("Test 4: count pill is absent when count is undefined", () => {
    render(
      <SectionHeader
        title="Outline"
        expanded={true}
        onToggle={() => {}}
        ariaCollapsedLabel="Expand Outline"
        ariaExpandedLabel="Collapse Outline"
      />,
    );
    expect(screen.queryByText(/^\d+$/)).toBeNull();
  });

  it("Test 5: count pill renders the count when provided", () => {
    render(
      <SectionHeader
        title="Linked mentions"
        expanded={true}
        onToggle={() => {}}
        count={7}
        ariaCollapsedLabel="Expand Linked mentions"
        ariaExpandedLabel="Collapse Linked mentions"
      />,
    );
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("Test 6: aria-expanded reflects the expanded prop", () => {
    const { rerender } = render(
      <SectionHeader
        title="Tags"
        expanded={true}
        onToggle={() => {}}
        ariaCollapsedLabel="Expand Tags"
        ariaExpandedLabel="Collapse Tags"
      />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");

    rerender(
      <SectionHeader
        title="Tags"
        expanded={false}
        onToggle={() => {}}
        ariaCollapsedLabel="Expand Tags"
        ariaExpandedLabel="Collapse Tags"
      />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  it("Test 7: aria-label switches between the collapsed and expanded copy", () => {
    const { rerender } = render(
      <SectionHeader
        title="Tags"
        expanded={true}
        onToggle={() => {}}
        ariaCollapsedLabel="Expand Tags"
        ariaExpandedLabel="Collapse Tags"
      />,
    );
    expect(screen.getByRole("button")).toHaveAccessibleName("Collapse Tags");

    rerender(
      <SectionHeader
        title="Tags"
        expanded={false}
        onToggle={() => {}}
        ariaCollapsedLabel="Expand Tags"
        ariaExpandedLabel="Collapse Tags"
      />,
    );
    expect(screen.getByRole("button")).toHaveAccessibleName("Expand Tags");
  });

  it("Test 8: entire header is a single <button> element (whole-row-clickable)", () => {
    const { container } = render(
      <SectionHeader
        title="Outline"
        expanded={true}
        onToggle={() => {}}
        ariaCollapsedLabel="Expand Outline"
        ariaExpandedLabel="Collapse Outline"
      />,
    );
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    expect(screen.getByText("Outline").closest("button")).toBe(buttons[0]);
  });

  it("Test 9: does not render an X close icon", () => {
    const { container } = render(
      <SectionHeader
        title="Outline"
        expanded={true}
        onToggle={() => {}}
        ariaCollapsedLabel="Expand Outline"
        ariaExpandedLabel="Collapse Outline"
      />,
    );
    expect(container.querySelector(".lucide-x")).toBeNull();
  });
});

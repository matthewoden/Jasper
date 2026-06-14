/**
 * Tests for ActiveTagFilterChip component.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useTreeStore } from "../lib/useTreeStore";

import { ActiveTagFilterChip } from "./ActiveTagFilterChip";

beforeEach(() => {
  useTreeStore.setState({ activeTagFilter: null });
});

describe("ActiveTagFilterChip", () => {
  it("Test 1: when activeTagFilter is null, renders nothing", () => {
    useTreeStore.setState({ activeTagFilter: null });
    const { container } = render(<ActiveTagFilterChip />);
    expect(container.firstChild).toBeNull();
  });

  it("Test 2: when activeTagFilter='project', renders 'Filtered by:' and '#project' text", () => {
    useTreeStore.setState({ activeTagFilter: "project" });
    render(<ActiveTagFilterChip />);

    expect(screen.getByText("Filtered by:")).toBeInTheDocument();
    expect(screen.getByText("#project")).toBeInTheDocument();
  });

  it("Test 3: prefix span has --color-muted; tag span has --color-accent and fontWeight 600", () => {
    useTreeStore.setState({ activeTagFilter: "project" });
    render(<ActiveTagFilterChip />);

    const prefixEl = screen.getByText("Filtered by:");
    const tagEl = screen.getByText("#project");

    expect(prefixEl).toHaveStyle({ color: "var(--color-muted)" });
    expect(tagEl).toHaveStyle({ color: "var(--color-accent)", fontWeight: "600" });
  });

  it("Test 4: × button has correct aria-label, cursor pointer, and contains an X icon", () => {
    useTreeStore.setState({ activeTagFilter: "project" });
    render(<ActiveTagFilterChip />);

    const dismissBtn = screen.getByRole("button", {
      name: "Remove tag filter: #project",
    });
    expect(dismissBtn).toBeInTheDocument();
    expect(dismissBtn).toHaveStyle({ cursor: "pointer" });
    expect(dismissBtn.querySelector("svg")).not.toBeNull();
  });

  it("Test 5: × button color is --color-fg normally and --color-accent on hover", () => {
    useTreeStore.setState({ activeTagFilter: "project" });
    render(<ActiveTagFilterChip />);

    const dismissBtn = screen.getByRole("button", {
      name: "Remove tag filter: #project",
    });

    expect(dismissBtn).toHaveStyle({ color: "var(--color-fg)" });

    fireEvent.mouseEnter(dismissBtn);
    expect(dismissBtn).toHaveStyle({ color: "var(--color-accent)" });

    fireEvent.mouseLeave(dismissBtn);
    expect(dismissBtn).toHaveStyle({ color: "var(--color-fg)" });
  });

  it("Test 6: clicking × button calls setActiveTagFilter(null)", () => {
    useTreeStore.setState({ activeTagFilter: "project" });
    render(<ActiveTagFilterChip />);

    const dismissBtn = screen.getByRole("button", {
      name: "Remove tag filter: #project",
    });
    fireEvent.click(dismissBtn);

    expect(useTreeStore.getState().activeTagFilter).toBeNull();
  });

  it("Test 7: the chip outer element has width: 100%", () => {
    useTreeStore.setState({ activeTagFilter: "project" });
    const { container } = render(<ActiveTagFilterChip />);

    const chip = container.firstChild as HTMLElement;
    expect(chip).toHaveStyle({ width: "100%" });
  });
});

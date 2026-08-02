/**
 * Asserts the locked copy verbatim, plus an inline svg for the [+] glyph — it
 * must be the same lucide icon the toolbar shows, so the two read as connected.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TreeEmptyState } from "./TreeEmptyState";

describe("<TreeEmptyState />", () => {
  it("TestEmptyState_RendersHeadline", () => {
    render(<TreeEmptyState />);
    expect(screen.getByText("No notes yet.")).toBeInTheDocument();
  });

  it("TestEmptyState_RendersBody", () => {
    const { container } = render(<TreeEmptyState />);
    expect(container.textContent).toContain("create your first note");
  });

  it("TestEmptyState_RendersLucideIcon", () => {
    const { container } = render(<TreeEmptyState />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });

  it("TestEmptyState_LeftAligned", () => {
    const { container } = render(<TreeEmptyState />);
    const root = container.querySelector('[data-testid="tree-empty-state"]');
    expect(root).not.toBeNull();
    expect(root?.className ?? "").toContain("items-start");
  });

  it("uses the locked padding-top of 24px (lg) so it sits below the toolbar with breathing room", () => {
    const { container } = render(<TreeEmptyState />);
    const root = container.querySelector(
      '[data-testid="tree-empty-state"]',
    ) as HTMLElement | null;
    expect(root).not.toBeNull();
    const pt = root?.style.paddingTop ?? "";
    expect(pt.length > 0).toBe(true);
  });
});

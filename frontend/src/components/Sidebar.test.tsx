/**
 * Sidebar tests — Phase 1 contract is static text + active-row treatment +
 * zero interactive elements. Reads VERBATIM from 01-UI-SPEC.md §Sidebar.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Sidebar } from "./Sidebar";

describe("<Sidebar />", () => {
  it("S1: header reads 'NOTES' (uppercased) with semibold + letter-spacing", () => {
    render(<Sidebar />);
    const header = screen.getByText("NOTES");
    expect(header).toBeInTheDocument();
    expect(header.tagName).toBe("HEADER");
    expect(header.className).toMatch(/uppercase/);
    expect(header.className).toMatch(/font-semibold/);
    expect(header.style.letterSpacing).toBe("0.05em");
  });

  it("S2: single 'scratchpad' row has the active treatment", () => {
    render(<Sidebar />);
    const row = screen.getByText("scratchpad");
    expect(row.tagName).toBe("LI");
    expect(row.className).toMatch(/text-accent/);
    expect(row.className).toMatch(/border-l-2/);
    expect(row.className).toMatch(/border-accent/);
    expect(row.getAttribute("aria-current")).toBe("page");
  });

  it("S3: NO interactive elements — no buttons, no inputs, no SVG icons", () => {
    const { container } = render(<Sidebar />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("nav has the locked aria-label", () => {
    render(<Sidebar />);
    expect(screen.getByLabelText("Notes navigation")).toBeInTheDocument();
  });

  it("renders exactly one list item (the scratchpad row)", () => {
    const { container } = render(<Sidebar />);
    expect(container.querySelectorAll("li").length).toBe(1);
  });
});

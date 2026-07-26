/**
 * shared.tsx primitive tests — the accessibility contract every section
 * file depends on.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ControlRow } from "./shared";

describe("ControlRow", () => {
  it("wires the label's for attribute to the child control's id", () => {
    render(
      <ControlRow label="Font size" htmlFor="test-font-size">
        <input id="test-font-size" aria-label="Font size" />
      </ControlRow>,
    );

    const label = screen.getByText("Font size");
    const input = screen.getByLabelText("Font size");
    expect(label).toHaveAttribute("for", "test-font-size");
    expect(input).toHaveAttribute("id", "test-font-size");
  });

  it("renders the description when supplied", () => {
    render(
      <ControlRow label="Accent color" description="Used for links, tags, highlights and selection">
        <div />
      </ControlRow>,
    );

    expect(screen.getByText("Used for links, tags, highlights and selection")).toBeInTheDocument();
  });

  it("renders no description element when the prop is omitted", () => {
    render(
      <ControlRow label="Font size" htmlFor="test-font-size">
        <input id="test-font-size" aria-label="Font size" />
      </ControlRow>,
    );

    expect(screen.getByText("Font size").nextSibling).toBeNull();
  });

  it("renders the primary label as a <label> bound to htmlFor when supplied", () => {
    render(
      <ControlRow label="Font size" htmlFor="test-font-size">
        <input id="test-font-size" aria-label="Font size" />
      </ControlRow>,
    );

    const label = screen.getByText("Font size");
    expect(label.tagName).toBe("LABEL");
    expect(label).toHaveAttribute("for", "test-font-size");
  });

  it("renders the primary label as a non-<label> element when htmlFor is omitted", () => {
    render(
      <ControlRow label="Accent color">
        <div />
      </ControlRow>,
    );

    const label = screen.getByText("Accent color");
    expect(label.tagName).not.toBe("LABEL");
  });
});

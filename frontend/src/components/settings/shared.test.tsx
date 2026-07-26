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
});

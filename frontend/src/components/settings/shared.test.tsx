/**
 * shared.tsx primitive tests — the accessibility contract every section
 * file depends on.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ControlRow, controlDescriptionId } from "./shared";

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

    // The label column must hold the label and nothing else. A nextSibling
    // check would also pass if a description were rendered elsewhere in the
    // row rather than not at all.
    const column = screen.getByText("Font size").parentElement!;
    expect(column.children).toHaveLength(1);
    expect(column.children[0]).toBe(screen.getByText("Font size"));
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

  it("gives the description an id a control can point aria-describedby at (32-REVIEW)", () => {
    render(
      <ControlRow
        label="Font size"
        htmlFor="test-font-size"
        description="Body text size in the editor · 8–32px"
      >
        <input
          id="test-font-size"
          aria-label="Font size"
          aria-describedby={controlDescriptionId("test-font-size")}
        />
      </ControlRow>,
    );

    const input = screen.getByLabelText("Font size");
    const descId = input.getAttribute("aria-describedby");
    expect(descId).toBe("test-font-size-desc");
    expect(document.getElementById(descId!)).toHaveTextContent(
      "Body text size in the editor · 8–32px",
    );
  });

  it("omits the description id when there is no htmlFor to derive it from", () => {
    render(
      <ControlRow label="Accent color" description="Used for links, tags, highlights and selection">
        <div />
      </ControlRow>,
    );

    expect(
      screen.getByText("Used for links, tags, highlights and selection"),
    ).not.toHaveAttribute("id");
  });

  // G-02: the column is `width: 160`, NOT `minWidth: 160`. A caption long
  // enough to grow the column would desynchronise the slider tracks beside
  // it — the exact regression 32-12 closed. Asserted for both the captioned
  // and uncaptioned row so a future long label in Editor / Daily notes is
  // covered too (32-REVIEW).
  it("hard-caps the label column at 160px whether or not a description is present", () => {
    const { unmount } = render(
      <ControlRow
        label="Font size"
        htmlFor="test-font-size"
        description="Body text size in the editor · 8–32px"
      >
        <input id="test-font-size" aria-label="Font size" />
      </ControlRow>,
    );
    const captionedColumn = screen.getByText("Font size").parentElement!;
    expect(captionedColumn).toHaveStyle({ width: "160px", flexShrink: "0" });
    expect(captionedColumn.style.minWidth).toBe("");
    unmount();

    render(
      <ControlRow label="Autosave interval" htmlFor="test-autosave">
        <input id="test-autosave" aria-label="Autosave interval" />
      </ControlRow>,
    );
    const plainColumn = screen.getByText("Autosave interval").parentElement!;
    expect(plainColumn).toHaveStyle({ width: "160px", flexShrink: "0" });
    expect(plainColumn.style.minWidth).toBe("");
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

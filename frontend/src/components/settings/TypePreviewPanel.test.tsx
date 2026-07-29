import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TypePreviewPanel } from "./TypePreviewPanel";

describe("TypePreviewPanel", () => {
  it("renders exactly one paragraph", () => {
    const { container } = render(<TypePreviewPanel fontSize={15} lineHeight={1.45} />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  // The paragraph reads --editor-font-size / --editor-line-height so a drag
  // moves it on every step (SliderNumberPair writes those properties live).
  // The props are the fallback for when the properties are unset, and still
  // track config, so both halves are asserted here. jsdom does not resolve
  // var() in getComputedStyle — live resolution is pinned by the SET3-07 E2E.
  it("reads the live CSS custom properties, falling back to the props", () => {
    const { container, rerender } = render(<TypePreviewPanel fontSize={15} lineHeight={1.45} />);
    const p = container.querySelector("p") as HTMLParagraphElement;
    expect(p.style.fontSize).toBe("var(--editor-font-size, 15px)");
    expect(p.style.lineHeight).toBe("var(--editor-line-height, 1.45)");

    rerender(<TypePreviewPanel fontSize={22} lineHeight={1.8} />);
    expect(p.style.fontSize).toBe("var(--editor-font-size, 22px)");
    expect(p.style.lineHeight).toBe("var(--editor-line-height, 1.8)");
  });

  it("renders exactly two accent-colored spans (fake link + fake tag)", () => {
    const { container } = render(<TypePreviewPanel fontSize={15} lineHeight={1.45} />);
    const accentSpans = Array.from(container.querySelectorAll("span")).filter(
      (el) => el.style.color === "var(--color-accent)",
    );
    expect(accentSpans).toHaveLength(2);
  });

  it("renders no heading or list elements inside the card (D-25)", () => {
    const { container } = render(<TypePreviewPanel fontSize={15} lineHeight={1.45} />);
    expect(container.querySelector("h1,h2,h3,h4,h5,h6,ul,ol")).toBeNull();
  });

  it("sets fontFamily to var(--font-reading)", () => {
    const { container } = render(<TypePreviewPanel fontSize={15} lineHeight={1.45} />);
    const p = container.querySelector("p") as HTMLParagraphElement;
    expect(p.style.fontFamily).toBe("var(--font-reading)");
  });
});

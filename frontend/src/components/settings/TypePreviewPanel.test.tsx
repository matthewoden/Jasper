import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TypePreviewPanel } from "./TypePreviewPanel";

describe("TypePreviewPanel", () => {
  it("renders exactly one paragraph", () => {
    const { container } = render(<TypePreviewPanel fontSize={15} lineHeight={1.45} />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("reflects the fontSize prop inline and updates when the prop changes", () => {
    const { container, rerender } = render(<TypePreviewPanel fontSize={15} lineHeight={1.45} />);
    const p = container.querySelector("p") as HTMLParagraphElement;
    expect(p.style.fontSize).toBe("15px");

    rerender(<TypePreviewPanel fontSize={22} lineHeight={1.45} />);
    expect(p.style.fontSize).toBe("22px");
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

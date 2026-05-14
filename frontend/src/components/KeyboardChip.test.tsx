import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { KeyboardChip } from "./KeyboardChip";

describe("KeyboardChip", () => {
  it("renders text inside a <kbd> element", () => {
    const { container } = render(<KeyboardChip>⌘O</KeyboardChip>);
    const kbd = container.querySelector("kbd");
    expect(kbd).toBeTruthy();
    expect(kbd?.textContent).toBe("⌘O");
  });

  it("renders multi-key shortcut as a single chip", () => {
    const { container } = render(<KeyboardChip>⌘⇧D</KeyboardChip>);
    const kbds = container.querySelectorAll("kbd");
    expect(kbds.length).toBe(1);
    expect(kbds[0].textContent).toBe("⌘⇧D");
  });

  it("uses var(--color-*) tokens (no hex literals)", () => {
    const { container } = render(<KeyboardChip>⌘B</KeyboardChip>);
    const kbd = container.querySelector("kbd")!;
    const style = kbd.getAttribute("style") || "";
    // No hex literals
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    // Token consumption (at least color-mix or var() present)
    expect(style).toMatch(/var\(--color-/);
  });
});

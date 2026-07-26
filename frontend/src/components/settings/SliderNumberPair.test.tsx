import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SliderNumberPair } from "./SliderNumberPair";

function renderPair(overrides: Partial<React.ComponentProps<typeof SliderNumberPair>> = {}) {
  const onCommit = vi.fn();
  render(
    <SliderNumberPair
      id="settings-font-size"
      label="Font size"
      value={15}
      sliderMin={12}
      sliderMax={24}
      numberMin={8}
      numberMax={32}
      step={1}
      unit="px"
      cssVar="--editor-font-size"
      formatCssValue={(v) => `${v}px`}
      onCommit={onCommit}
      {...overrides}
    />,
  );
  return { onCommit };
}

describe("SliderNumberPair", () => {
  it("dragging the range updates the CSS var on every change but never calls onCommit mid-drag", () => {
    const { onCommit } = renderPair();
    const range = screen.getByRole("slider", { name: "Font size" });

    fireEvent.change(range, { target: { value: "16" } });
    fireEvent.change(range, { target: { value: "18" } });
    fireEvent.change(range, { target: { value: "20" } });

    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("20px");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("pointerUp after a drag calls onCommit exactly once with the final value", () => {
    const { onCommit } = renderPair();
    const range = screen.getByRole("slider", { name: "Font size" });

    fireEvent.change(range, { target: { value: "16" } });
    fireEvent.change(range, { target: { value: "20" } });
    fireEvent.pointerUp(range);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(20);
  });

  it("keyUp after adjusting the range via keyboard commits exactly once, after a short settle delay (WR-02 debounce)", () => {
    vi.useFakeTimers();
    try {
      const { onCommit } = renderPair();
      const range = screen.getByRole("slider", { name: "Font size" });

      fireEvent.change(range, { target: { value: "17" } });
      fireEvent.keyUp(range, { key: "ArrowRight" });

      // Not committed synchronously -- a single discrete key press debounces
      // rather than firing immediately, but still commits once settled.
      expect(onCommit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith(17);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rapid/repeated arrow-key events coalesce into a single trailing commit, never one PUT per key event (WR-02)", () => {
    vi.useFakeTimers();
    try {
      const { onCommit } = renderPair();
      const range = screen.getByRole("slider", { name: "Font size" });

      // Simulate auto-repeat: several change+keyUp pairs in quick
      // succession, each well inside the debounce window.
      fireEvent.change(range, { target: { value: "16" } });
      fireEvent.keyUp(range, { key: "ArrowRight" });
      vi.advanceTimersByTime(50);
      fireEvent.change(range, { target: { value: "17" } });
      fireEvent.keyUp(range, { key: "ArrowRight" });
      vi.advanceTimersByTime(50);
      fireEvent.change(range, { target: { value: "18" } });
      fireEvent.keyUp(range, { key: "ArrowRight" });

      expect(onCommit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith(18);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pointerUp right after a key press cancels the pending debounced commit and fires exactly once", () => {
    vi.useFakeTimers();
    try {
      const { onCommit } = renderPair();
      const range = screen.getByRole("slider", { name: "Font size" });

      fireEvent.change(range, { target: { value: "17" } });
      fireEvent.keyUp(range, { key: "ArrowRight" });
      fireEvent.change(range, { target: { value: "19" } });
      fireEvent.pointerUp(range);

      // pointerUp commits immediately with the latest value and cancels the
      // still-pending keyboard debounce timer.
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith(19);

      vi.advanceTimersByTime(300);
      expect(onCommit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("typing an out-of-range number and blurring reverts, shows the error, and never commits", () => {
    const { onCommit } = renderPair();
    const number = screen.getByRole("spinbutton", { name: "Font size" });

    fireEvent.change(number, { target: { value: "40" } });
    fireEvent.blur(number);

    expect(onCommit).not.toHaveBeenCalled();
    expect(number).toHaveValue(15);
    expect(screen.getByRole("alert").textContent).toMatch(/must be between 8 and 32/);
  });

  it("typing a valid in-range number and pressing Enter commits exactly once", () => {
    const { onCommit } = renderPair();
    const number = screen.getByRole("spinbutton", { name: "Font size" });

    fireEvent.change(number, { target: { value: "20" } });
    fireEvent.keyDown(number, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(20);
  });

  it("renders exactly one range input and one number input", () => {
    renderPair();
    expect(screen.getAllByRole("slider")).toHaveLength(1);
    expect(screen.getAllByRole("spinbutton")).toHaveLength(1);
  });

  it("renders the unit slot at a fixed width even when unit is empty", () => {
    renderPair({ unit: "" });
    const unitSlot = screen.getByTestId("settings-font-size-unit");
    expect(unitSlot).toBeInTheDocument();
    expect(unitSlot).toHaveStyle({ width: "24px" });
    expect(unitSlot.textContent).toBe("");
  });

  it("renders the same element-child count in the control row regardless of unit presence", () => {
    renderPair({ unit: "px" });
    const rowWithUnit = screen.getByRole("slider", { name: "Font size" }).parentElement;
    const childCountWithUnit = rowWithUnit?.children.length;
    cleanup();

    renderPair({ unit: "" });
    const rowWithoutUnit = screen.getByRole("slider", { name: "Font size" }).parentElement;
    expect(rowWithoutUnit?.children.length).toBe(childCountWithUnit);
  });

  it("resets the CSS var to the prop-derived value when value prop changes (revert-on-failed-save)", () => {
    const { rerender } = render(
      <SliderNumberPair
        id="settings-font-size"
        label="Font size"
        value={15}
        sliderMin={12}
        sliderMax={24}
        numberMin={8}
        numberMax={32}
        step={1}
        unit="px"
        cssVar="--editor-font-size"
        formatCssValue={(v) => `${v}px`}
        onCommit={vi.fn()}
      />,
    );
    const range = screen.getByRole("slider", { name: "Font size" });
    fireEvent.change(range, { target: { value: "22" } });
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("22px");

    rerender(
      <SliderNumberPair
        id="settings-font-size"
        label="Font size"
        value={15}
        sliderMin={12}
        sliderMax={24}
        numberMin={8}
        numberMax={32}
        step={1}
        unit="px"
        cssVar="--editor-font-size"
        formatCssValue={(v) => `${v}px`}
        onCommit={vi.fn()}
      />,
    );
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("15px");
  });
});

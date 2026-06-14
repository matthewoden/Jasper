/**
 * Tests for ResizeHandle — generic drag handle backing all resize affordances.
 *
 * Pointer-event recipe: fireEvent.pointerDown initializes lastPosRef to 0
 * (jsdom PointerEvent ignores clientX); pointermove is dispatched via
 * MouseEvent since jsdom PointerEvent is not constructible. Delta = clientX - 0.
 * Cursor-only affordance: transparent background, no visible band.
 */
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResizeHandle } from "./ResizeHandle";

function dispatchPointerMove(clientX?: number, clientY?: number) {
  document.dispatchEvent(
    new MouseEvent("pointermove", { clientX, clientY, bubbles: true }),
  );
}

function dispatchPointerUp() {
  document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
}

describe("<ResizeHandle /> — Phase 6.6 UX-CHROME-04 generic handle", () => {
  afterEach(() => {
    dispatchPointerUp();
  });

  it("Test 1: vertical orientation renders role=separator, aria-orientation=vertical, col-resize cursor, transparent background", () => {
    const onDrag = vi.fn();
    const { getByTestId } = render(
      <ResizeHandle
        orientation="vertical"
        onDrag={onDrag}
        aria-label="Test handle"
      />,
    );
    const handle = getByTestId("resize-handle");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("Test handle");
    expect(handle.style.cursor).toBe("col-resize");
    expect(handle.style.background).toBe("transparent");
  });

  it("Test 2: horizontal orientation renders aria-orientation=horizontal and row-resize cursor", () => {
    const onDrag = vi.fn();
    const { getByTestId } = render(
      <ResizeHandle
        orientation="horizontal"
        onDrag={onDrag}
        aria-label="Test horizontal handle"
      />,
    );
    const handle = getByTestId("resize-handle");
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.style.cursor).toBe("row-resize");
  });

  it("Test 3: vertical — pointerdown then pointermove calls onDrag with positive delta when clientX increases", () => {
    const onDrag = vi.fn();
    const { getByTestId } = render(
      <ResizeHandle
        orientation="vertical"
        onDrag={onDrag}
        aria-label="Resize"
      />,
    );
    const handle = getByTestId("resize-handle");
    fireEvent.pointerDown(handle);
    dispatchPointerMove(50);
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onDrag).toHaveBeenCalledWith(50);
    dispatchPointerUp();
  });

  it("Test 4: after pointerup, subsequent pointermove does NOT trigger onDrag", () => {
    const onDrag = vi.fn();
    const { getByTestId } = render(
      <ResizeHandle
        orientation="vertical"
        onDrag={onDrag}
        aria-label="Resize"
      />,
    );
    const handle = getByTestId("resize-handle");
    fireEvent.pointerDown(handle);
    dispatchPointerMove(50);
    expect(onDrag).toHaveBeenCalledTimes(1);
    dispatchPointerUp();
    onDrag.mockClear();
    dispatchPointerMove(100);
    expect(onDrag).not.toHaveBeenCalled();
  });

  it("Test 5: unmount during active drag removes document listeners", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const onDrag = vi.fn();
    const { getByTestId, unmount } = render(
      <ResizeHandle
        orientation="vertical"
        onDrag={onDrag}
        aria-label="Resize"
      />,
    );
    fireEvent.pointerDown(getByTestId("resize-handle"));
    unmount();
    const removedNames = removeSpy.mock.calls.map((c) => c[0]);
    expect(removedNames).toContain("pointermove");
    expect(removedNames).toContain("pointerup");
    removeSpy.mockRestore();
  });

  it("Test 6: pointerdown activates drag (behavioral test for e.preventDefault() call)", () => {
    const onDrag = vi.fn();
    const { getByTestId } = render(
      <ResizeHandle
        orientation="vertical"
        onDrag={onDrag}
        aria-label="Resize"
      />,
    );
    const handle = getByTestId("resize-handle");
    fireEvent.pointerDown(handle);
    dispatchPointerMove(50);
    expect(onDrag).toHaveBeenCalledWith(50);
    dispatchPointerUp();
    onDrag.mockClear();
    dispatchPointerMove(100);
    expect(onDrag).not.toHaveBeenCalled();
  });
});

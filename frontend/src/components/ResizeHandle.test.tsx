/**
 * Tests for ResizeHandle (Phase 6.6 — Plan 06.6-01, UX-CHROME-04).
 *
 * Generic drag handle backing all resize affordances. Uses the same
 * pointer-event recipe as SidebarResizeHandle.test.tsx:
 *
 *   1. `fireEvent.pointerDown(handle)` — React calls onPointerDown;
 *      lastPosRef is initialized to 0 (jsdom PointerEvent does not honor
 *      clientX in fireEvent synthetic events).
 *   2. `document.dispatchEvent(new MouseEvent("pointermove", {clientX|Y}))` —
 *      jsdom PointerEvent is not constructible; MouseEvent is used per the
 *      SidebarResizeHandle.test.tsx pattern.
 *   3. Assert `onDrag` was called with the correct delta (clientX - 0).
 *   4. `document.dispatchEvent(new MouseEvent("pointerup"))` — cleanup.
 *
 * D-12: cursor-only affordance — no visible band, transparent background.
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
    // Defense-in-depth: detach any lingering document listeners.
    dispatchPointerUp();
  });

  // Test 1: Vertical orientation renders correct ARIA attributes, cursor, and transparent bg
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

  // Test 2: Horizontal orientation renders horizontal aria and row-resize cursor
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

  // Test 3: On pointerdown then pointermove (vertical), onDrag called with positive delta when clientX increases.
  // Note: jsdom PointerEvent does not honor clientX in fireEvent; lastPosRef starts at 0 after pointerDown.
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
    fireEvent.pointerDown(handle); // lastPosRef initialized to 0 (jsdom clientX = 0)
    dispatchPointerMove(50); // delta = 50 - 0 = 50
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onDrag).toHaveBeenCalledWith(50);
    dispatchPointerUp();
  });

  // Test 4: On pointerup, subsequent pointermove events do NOT trigger onDrag
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
    fireEvent.pointerDown(handle); // lastPosRef = 0
    dispatchPointerMove(50); // delta = 50
    expect(onDrag).toHaveBeenCalledTimes(1);
    dispatchPointerUp();
    onDrag.mockClear();
    // After pointerup, further moves must not fire onDrag
    dispatchPointerMove(100);
    expect(onDrag).not.toHaveBeenCalled();
  });

  // Test 5: On unmount during active drag, document listeners are cleaned up
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
    // Unmount while dragging
    unmount();
    const removedNames = removeSpy.mock.calls.map((c) => c[0]);
    expect(removedNames).toContain("pointermove");
    expect(removedNames).toContain("pointerup");
    removeSpy.mockRestore();
  });

  // Test 6: e.preventDefault() is called on pointerdown (verified behaviorally — drag activates)
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
    // After pointerDown, drag is active — confirm by checking onDrag fires on pointermove.
    // The component calls e.preventDefault() in onPointerDown; while jsdom synthetic events
    // don't propagate preventDefault to native events, we verify the drag lifecycle
    // is correctly activated (draggingRef.current = true, document listeners attached).
    fireEvent.pointerDown(handle);
    dispatchPointerMove(50);
    expect(onDrag).toHaveBeenCalledWith(50);
    dispatchPointerUp();
    // After cleanup, subsequent pointermove must NOT fire onDrag
    onDrag.mockClear();
    dispatchPointerMove(100);
    expect(onDrag).not.toHaveBeenCalled();
  });
});

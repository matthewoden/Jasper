/**
 * Tests for SidebarResizeHandle (Phase 5.5 — Plan 05, UX-09).
 *
 * The component attaches `pointermove` + `pointerup` listeners to `document`
 * inside its `onPointerDown` React handler. We exercise the recipe end-to-end:
 *
 *   1. `fireEvent.pointerDown(handle)` — React calls the bound onPointerDown,
 *      which sets `draggingRef.current = true` and registers the document
 *      listeners.
 *   2. `document.dispatchEvent(new MouseEvent("pointermove", {clientX}))` —
 *      jsdom does NOT expose a `PointerEvent` constructor (verified at the
 *      time of writing), but the addEventListener("pointermove", …) callback
 *      reads only `e.clientX`, which `MouseEvent` provides. Dispatching a
 *      `MouseEvent` whose `.type === "pointermove"` is a faithful stand-in.
 *   3. The handler calls `setSidebarWidth(clamp(MIN, clientX, MAX))`; we
 *      assert against `useTreeStore.getState().sidebarWidth`.
 *   4. `document.dispatchEvent(new MouseEvent("pointerup"))` runs the
 *      cleanup branch; subsequent pointermove dispatches are no-ops.
 *
 * Each test resets the store's `sidebarWidth` to the default before
 * dispatching events so assertions are deterministic.
 */
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SIDEBAR_WIDTH_DEFAULT,
  useTreeStore,
} from "../lib/useTreeStore";
import { SidebarResizeHandle } from "./SidebarResizeHandle";

function dispatchPointerMove(clientX: number) {
  // jsdom: PointerEvent is not constructible; MouseEvent dispatched with
  // a pointermove `type` reaches addEventListener("pointermove", ...) and
  // exposes `.clientX` to the handler.
  document.dispatchEvent(
    new MouseEvent("pointermove", { clientX, bubbles: true }),
  );
}

function dispatchPointerUp() {
  document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
}

describe("<SidebarResizeHandle /> — UX-09 pointer-events recipe", () => {
  beforeEach(() => {
    // Reset to default; clears any width persisted by other tests.
    useTreeStore.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
  });

  afterEach(() => {
    // Defense-in-depth: ensure document listeners are not left attached
    // by an aborted test.
    dispatchPointerUp();
    useTreeStore.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
  });

  it("UX-09: renders with role=separator + aria-orientation + aria-label + col-resize cursor", () => {
    const { getByTestId } = render(<SidebarResizeHandle />);
    const handle = getByTestId("sidebar-resize-handle");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("Resize sidebar");
    expect(handle.style.cursor).toBe("col-resize");
    expect(handle.style.width).toBe("4px");
  });

  it("UX-09: pointermove updates sidebarWidth when dragging", () => {
    const { getByTestId } = render(<SidebarResizeHandle />);
    const handle = getByTestId("sidebar-resize-handle");
    fireEvent.pointerDown(handle);
    dispatchPointerMove(400);
    expect(useTreeStore.getState().sidebarWidth).toBe(400);
    // Cleanup so subsequent tests don't see leaked listeners.
    dispatchPointerUp();
  });

  it("UX-09: clamps to MIN on pointermove (cannot shrink below default)", () => {
    const { getByTestId } = render(<SidebarResizeHandle />);
    const handle = getByTestId("sidebar-resize-handle");
    fireEvent.pointerDown(handle);
    dispatchPointerMove(100); // below MIN (260)
    expect(useTreeStore.getState().sidebarWidth).toBe(260);
    dispatchPointerUp();
  });

  it("UX-09: pointerup detaches listeners — subsequent pointermove is a no-op", () => {
    const { getByTestId } = render(<SidebarResizeHandle />);
    const handle = getByTestId("sidebar-resize-handle");
    fireEvent.pointerDown(handle);
    dispatchPointerMove(400);
    expect(useTreeStore.getState().sidebarWidth).toBe(400);
    dispatchPointerUp();
    // Width must NOT change after pointerup.
    dispatchPointerMove(700);
    expect(useTreeStore.getState().sidebarWidth).toBe(400);
  });
});

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
import { __testing__ } from "./sidebarResizeHandle.utils";

function dispatchPointerMove(clientX: number) {
  document.dispatchEvent(
    new MouseEvent("pointermove", { clientX, bubbles: true }),
  );
}

function dispatchPointerUp() {
  document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
}

describe("<SidebarResizeHandle /> — UX-09 pointer-events recipe", () => {
  beforeEach(() => {
    useTreeStore.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
  });

  afterEach(() => {
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
    expect(handle.style.width).toBe("8px");
  });

  it("UX-09: pointermove updates sidebarWidth when dragging", () => {
    const { getByTestId } = render(<SidebarResizeHandle />);
    const handle = getByTestId("sidebar-resize-handle");
    fireEvent.pointerDown(handle);
    dispatchPointerMove(400);
    expect(useTreeStore.getState().sidebarWidth).toBe(400);
    dispatchPointerUp();
  });

  it("UX-09: clamps to MIN on pointermove (cannot shrink below default)", () => {
    const { getByTestId } = render(<SidebarResizeHandle />);
    const handle = getByTestId("sidebar-resize-handle");
    fireEvent.pointerDown(handle);
    dispatchPointerMove(100);
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
    dispatchPointerMove(700);
    expect(useTreeStore.getState().sidebarWidth).toBe(400);
  });
});


describe("BL-03 narrow-viewport clamp (Phase 5.5 gap-closure Plan 11)", () => {
  const originalInnerWidth = Object.getOwnPropertyDescriptor(
    window,
    "innerWidth",
  );

  function setInnerWidth(px: number) {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: px,
    });
  }

  beforeEach(() => {
    useTreeStore.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
  });

  afterEach(() => {
    if (originalInnerWidth) {
      Object.defineProperty(window, "innerWidth", originalInnerWidth);
    } else {
      setInnerWidth(1024);
    }
    dispatchPointerUp();
    useTreeStore.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
  });

  it("BL-03 (wide viewport): computeMaxWidth returns innerWidth - EDITOR_MIN when both floors fit", () => {
    setInnerWidth(800);
    expect(__testing__.computeMaxWidth()).toBe(800 - __testing__.EDITOR_MIN);
    expect(__testing__.computeMaxWidth()).toBe(480);
  });

  it("BL-03 (narrow viewport): computeMaxWidth returns innerWidth - EDITOR_MIN (NOT MIN) when room < SIDEBAR_WIDTH_MIN", () => {
    setInnerWidth(500);
    expect(__testing__.computeMaxWidth()).toBe(180);
    expect(__testing__.computeMaxWidth()).not.toBe(260);
  });

  it("BL-03 (extreme narrow viewport): computeMaxWidth floors at 0 when innerWidth < EDITOR_MIN", () => {
    setInnerWidth(200);
    expect(__testing__.computeMaxWidth()).toBe(0);
  });

  it("BL-03 (dynamic viewport): computeMaxWidth re-reads window.innerWidth on every call (not memoized)", () => {
    setInnerWidth(900);
    expect(__testing__.computeMaxWidth()).toBe(580);
    setInnerWidth(600);
    expect(__testing__.computeMaxWidth()).toBe(280);
  });

  it("BL-03 (live-pointermove clamp): pointermove on a narrow viewport clamps to live computeMaxWidth, not clientX", () => {
    setInnerWidth(500);
    const { getByTestId } = render(<SidebarResizeHandle />);
    const handle = getByTestId("sidebar-resize-handle");
    fireEvent.pointerDown(handle);
    dispatchPointerMove(450);
    expect(useTreeStore.getState().sidebarWidth).toBe(180);
    dispatchPointerUp();
  });

  it("BL-03 (mid-drag resize): pointermove uses the LIVE viewport, so a window-resize-narrower mid-drag tightens the bound immediately", () => {
    setInnerWidth(900);
    const { getByTestId } = render(<SidebarResizeHandle />);
    const handle = getByTestId("sidebar-resize-handle");
    fireEvent.pointerDown(handle);
    dispatchPointerMove(500);
    expect(useTreeStore.getState().sidebarWidth).toBe(500);

    setInnerWidth(600);
    dispatchPointerMove(500);
    expect(useTreeStore.getState().sidebarWidth).toBe(280);

    dispatchPointerUp();
  });
});

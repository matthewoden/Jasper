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
import {
  __testing__,
  SidebarResizeHandle,
} from "./SidebarResizeHandle";

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
    expect(handle.style.width).toBe("8px"); // Phase 6.6 D-12: 8px hit area
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

// ──────────────────────────────────────────────────────────────────────────
// BL-03 narrow-viewport clamp (Phase 5.5 gap-closure Plan 11).
//
// Previously `computeMaxWidth = Math.max(SIDEBAR_WIDTH_MIN, innerWidth - 320)`
// floored to MIN whenever the viewport was too narrow for both the sidebar
// MIN (260) and the editor floor (320). On a 500px window that meant the
// sidebar could occupy 260px and force the editor pane down to 240px (40px
// below the documented guarantee).
//
// Replacement: when the viewport can't satisfy both floors, give the editor
// pane whatever's left (`innerWidth - EDITOR_MIN`, floored at 0). The
// sidebar may end up narrower than its preferred MIN on tiny viewports —
// acceptable degradation for the unsupported-but-not-broken case.
// ──────────────────────────────────────────────────────────────────────────
describe("BL-03 narrow-viewport clamp (Phase 5.5 gap-closure Plan 11)", () => {
  // We mutate window.innerWidth via Object.defineProperty (jsdom default
  // is 1024). Save the original descriptor so we can restore between tests.
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
    // Restore original descriptor (or set back to a sensible default).
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
    // room = 500 - 320 = 180 < 260; the OLD code returned 260 (the MIN
    // floor), letting the sidebar consume 260px and pushing the editor to
    // 240px. The fix: return 180 so the sidebar can't grow past the
    // available room, preserving the editor floor.
    expect(__testing__.computeMaxWidth()).toBe(180);
    expect(__testing__.computeMaxWidth()).not.toBe(260);
  });

  it("BL-03 (extreme narrow viewport): computeMaxWidth floors at 0 when innerWidth < EDITOR_MIN", () => {
    setInnerWidth(200);
    // room = 200 - 320 = -120 → clamped to 0. Degenerate but consistent;
    // host page is broken at this viewport size anyway.
    expect(__testing__.computeMaxWidth()).toBe(0);
  });

  it("BL-03 (dynamic viewport): computeMaxWidth re-reads window.innerWidth on every call (not memoized)", () => {
    setInnerWidth(900);
    expect(__testing__.computeMaxWidth()).toBe(580);
    setInnerWidth(600);
    // After resize, the next call must reflect the NEW viewport.
    expect(__testing__.computeMaxWidth()).toBe(280);
  });

  it("BL-03 (live-pointermove clamp): pointermove on a narrow viewport clamps to live computeMaxWidth, not clientX", () => {
    setInnerWidth(500); // computeMaxWidth() = 180
    const { getByTestId } = render(<SidebarResizeHandle />);
    const handle = getByTestId("sidebar-resize-handle");
    fireEvent.pointerDown(handle);
    // clientX 450 is well above the live max (180). Without the live clamp,
    // newWidth would float up toward clientX. With the fix, the upper bound
    // pins newWidth at computeMaxWidth() = 180.
    dispatchPointerMove(450);
    expect(useTreeStore.getState().sidebarWidth).toBe(180);
    dispatchPointerUp();
  });

  it("BL-03 (mid-drag resize): pointermove uses the LIVE viewport, so a window-resize-narrower mid-drag tightens the bound immediately", () => {
    setInnerWidth(900); // computeMaxWidth() = 580
    const { getByTestId } = render(<SidebarResizeHandle />);
    const handle = getByTestId("sidebar-resize-handle");
    fireEvent.pointerDown(handle);
    dispatchPointerMove(500); // 500 < 580 max → newWidth = 500
    expect(useTreeStore.getState().sidebarWidth).toBe(500);

    // Now narrow the viewport mid-drag.
    setInnerWidth(600); // new computeMaxWidth() = 280
    dispatchPointerMove(500); // now 500 > 280 max → newWidth = 280
    expect(useTreeStore.getState().sidebarWidth).toBe(280);

    dispatchPointerUp();
  });
});

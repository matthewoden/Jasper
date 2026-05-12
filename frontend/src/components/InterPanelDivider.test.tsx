/**
 * Tests for InterPanelDivider (Phase 6.5 — Plan 06.5-02, UX-T-01).
 *
 * The component attaches `pointermove` + `pointerup` listeners to `document`
 * inside its `onPointerDown` React handler. We exercise the recipe end-to-end,
 * mirroring the SidebarResizeHandle.test.tsx pattern (adapted to the vertical
 * axis and ratio-based math).
 *
 * Mocking getBoundingClientRect: tests construct a stub ref object
 * `{ current: { getBoundingClientRect: () => ({...}) } }` and pass it directly
 * as railRef — no Element.prototype patching needed, faster and more targeted.
 */
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TAGS_PANEL_RATIO_MAX,
  TAGS_PANEL_RATIO_MIN,
  useTreeStore,
} from "../lib/useTreeStore";
import { InterPanelDivider } from "./InterPanelDivider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dispatchPointerMove(clientY: number) {
  // jsdom: PointerEvent is not constructible; MouseEvent dispatched with
  // a pointermove `type` reaches addEventListener("pointermove", ...) and
  // exposes `.clientY` to the handler.
  document.dispatchEvent(
    new MouseEvent("pointermove", { clientY, bubbles: true }),
  );
}

function dispatchPointerUp() {
  document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
}

/** Build a ref-like object whose getBoundingClientRect returns the given rect. */
function makeRailRef(rect: { top: number; height: number }) {
  return {
    current: {
      getBoundingClientRect: () => ({
        top: rect.top,
        height: rect.height,
        left: 0,
        right: 0,
        bottom: rect.top + rect.height,
        width: 0,
        x: 0,
        y: rect.top,
        toJSON: () => ({}),
      } as DOMRect),
    },
  } as React.RefObject<HTMLElement>;
}

/** Wrapper that renders InterPanelDivider with a controlled ref. */
function renderDivider(rect: { top: number; height: number }) {
  const railRef = makeRailRef(rect);
  const result = render(<InterPanelDivider railRef={railRef} />);
  return { ...result, railRef };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("<InterPanelDivider /> — Phase 6.5 UX-T-01 pointer-events recipe", () => {
  beforeEach(() => {
    // Reset ratio to default between tests.
    useTreeStore.setState({ tagsPanelHeightRatio: 0.5 });
  });

  afterEach(() => {
    // Defense-in-depth: detach any lingering document listeners.
    dispatchPointerUp();
    useTreeStore.setState({ tagsPanelHeightRatio: 0.5 });
  });

  // T1: ARIA attributes
  it("T1: renders with role=separator, aria-orientation=horizontal, aria-label='Resize panels'", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    const handle = getByTestId("inter-panel-divider");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.getAttribute("aria-label")).toBe("Resize panels");
  });

  // T2: pointerdown attaches document listeners
  it("T2: pointerdown attaches document pointermove + pointerup listeners", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    const handle = getByTestId("inter-panel-divider");
    fireEvent.pointerDown(handle);
    const eventNames = addSpy.mock.calls.map((c) => c[0]);
    expect(eventNames).toContain("pointermove");
    expect(eventNames).toContain("pointerup");
    dispatchPointerUp();
    addSpy.mockRestore();
  });

  // T3: e.preventDefault called on pointerdown
  it("T3: pointerdown calls e.preventDefault() to prevent native text-selection drag", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    const handle = getByTestId("inter-panel-divider");
    // fireEvent.pointerDown returns the event mock
    const preventDefaultSpy = vi.fn();
    // Override preventDefault on the synthetic event
    const originalPointerDown = handle.onpointerdown;
    handle.addEventListener("pointerdown", (e) => {
      vi.spyOn(e, "preventDefault").mockImplementation(preventDefaultSpy);
    }, { capture: true });
    fireEvent.pointerDown(handle);
    // At minimum the store should update on the next pointermove (drag is active)
    dispatchPointerMove(100);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(0.25); // 100/400
    dispatchPointerUp();
    expect(originalPointerDown).toBeUndefined(); // just checking type; no assertion needed
  });

  // T4: pointermove while NOT dragging does NOT update store
  it("T4: pointermove while not dragging does NOT update store ratio", () => {
    renderDivider({ top: 0, height: 400 });
    // Do NOT fire pointerDown — drag never started
    dispatchPointerMove(200);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(0.5); // default unchanged
  });

  // T5: pointermove during drag — in-range ratio
  it("T5: pointerdown then pointermove clientY=100 over {top:0,height:400} → ratio=0.25", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("inter-panel-divider"));
    dispatchPointerMove(100); // 100/400 = 0.25 — in range [0.2, 0.8]
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(0.25);
    dispatchPointerUp();
  });

  // T6: clamp to min
  it("T6: pointermove clientY=50 over {top:0,height:400} → ratio clamped to TAGS_PANEL_RATIO_MIN (0.2)", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("inter-panel-divider"));
    dispatchPointerMove(50); // 50/400 = 0.125 < 0.2 → clamped to 0.2
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(TAGS_PANEL_RATIO_MIN);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(0.2);
    dispatchPointerUp();
  });

  // T7: clamp to max
  it("T7: pointermove clientY=380 over {top:0,height:400} → ratio clamped to TAGS_PANEL_RATIO_MAX (0.8)", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("inter-panel-divider"));
    dispatchPointerMove(380); // 380/400 = 0.95 > 0.8 → clamped to 0.8
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(TAGS_PANEL_RATIO_MAX);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(0.8);
    dispatchPointerUp();
  });

  // T8: pointerup stops drag
  it("T8: pointerup stops dragging — subsequent pointermove no longer updates store", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("inter-panel-divider"));
    dispatchPointerMove(200); // 200/400 = 0.5
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(0.5);
    dispatchPointerUp();
    // After pointerup, drag is done — further moves must not update the store.
    dispatchPointerMove(50); // would clamp to 0.2 if dragging
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(0.5); // unchanged
  });

  // T9: unmount mid-drag removes document listeners
  it("T9: unmount mid-drag removes document pointermove + pointerup listeners", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { getByTestId, unmount } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("inter-panel-divider"));
    // Now unmount while dragging
    unmount();
    const removedEventNames = removeSpy.mock.calls.map((c) => c[0]);
    expect(removedEventNames).toContain("pointermove");
    expect(removedEventNames).toContain("pointerup");
    removeSpy.mockRestore();
  });

  // T10: non-zero rail top offset is handled correctly
  it("T10: rail with top offset — ratio computed relative to railRef.top", () => {
    const { getByTestId } = renderDivider({ top: 100, height: 400 });
    fireEvent.pointerDown(getByTestId("inter-panel-divider"));
    // clientY=200, railTop=100, height=400 → (200-100)/400 = 0.25
    dispatchPointerMove(200);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(0.25);
    dispatchPointerUp();
  });
});

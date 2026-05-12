/**
 * Tests for InterPanelDivider (Phase 6.5 — Plan 06.5-02, UX-T-01).
 *
 * Phase 6.6 — Plan 06.6-01 (UX-CHROME-04): Updated tests to match the new
 * ResizeHandle delegation. The component now delegates pointer lifecycle to
 * ResizeHandle (renders data-testid="resize-handle") and uses delta-based
 * ratio math instead of absolute clientY position.
 *
 * Delta-based ratio math:
 *   newRatio = currentRatio + delta / railHeight
 *   where delta = clientY_move2 - clientY_move1 (or 0 at start since lastPosRef=0)
 *
 * Note: jsdom PointerEvent does not honor clientY in fireEvent.pointerDown;
 * the initial lastPosRef is 0. Delta = clientY dispatched in pointermove - 0.
 *
 * Mocking getBoundingClientRect: tests construct a stub ref object
 * `{ current: { getBoundingClientRect: () => ({...}) } }` and pass it directly
 * as railRef — no Element.prototype patching needed.
 *
 * D-12/D-14: cursor-only affordance — no visible band, transparent background.
 * D-15: delegates to ResizeHandle — data-testid is "resize-handle" (not "inter-panel-divider").
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

describe("<InterPanelDivider /> — Phase 6.5 UX-T-01 / Phase 6.6 UX-CHROME-04 delegation", () => {
  beforeEach(() => {
    // Reset ratio to default between tests.
    useTreeStore.setState({ tagsPanelHeightRatio: 0.5 });
  });

  afterEach(() => {
    // Defense-in-depth: detach any lingering document listeners.
    dispatchPointerUp();
    useTreeStore.setState({ tagsPanelHeightRatio: 0.5 });
  });

  // T1: ARIA attributes — delegated to ResizeHandle output (data-testid="resize-handle")
  it("T1: renders with role=separator, aria-orientation=horizontal, aria-label='Resize panels'", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    // Phase 6.6: delegates to ResizeHandle, which uses data-testid="resize-handle"
    const handle = getByTestId("resize-handle");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.getAttribute("aria-label")).toBe("Resize panels");
  });

  // T2: pointerdown attaches document listeners
  it("T2: pointerdown attaches document pointermove + pointerup listeners", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    const handle = getByTestId("resize-handle");
    fireEvent.pointerDown(handle);
    const eventNames = addSpy.mock.calls.map((c) => c[0]);
    expect(eventNames).toContain("pointermove");
    expect(eventNames).toContain("pointerup");
    dispatchPointerUp();
    addSpy.mockRestore();
  });

  // T3: drag activates on pointerdown (behavioral test for drag lifecycle)
  it("T3: pointerdown activates drag — pointermove updates ratio", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    const handle = getByTestId("resize-handle");
    fireEvent.pointerDown(handle);
    // Delta = 100 (clientY 100 - lastPosRef 0); ratio change = 100/400 = 0.25
    // New ratio = 0.5 + 0.25 = 0.75, clamped to MAX 0.8
    dispatchPointerMove(100);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBeCloseTo(0.75);
    dispatchPointerUp();
  });

  // T4: pointermove while NOT dragging does NOT update store
  it("T4: pointermove while not dragging does NOT update store ratio", () => {
    renderDivider({ top: 0, height: 400 });
    // Do NOT fire pointerDown — drag never started
    dispatchPointerMove(200);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(0.5); // default unchanged
  });

  // T5: delta-based ratio update — positive delta increases ratio
  it("T5: pointerdown then pointermove clientY=50 over {height:400} → ratio increases by 50/400=0.125", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("resize-handle"));
    // Delta = 50 (clientY 50 - lastPosRef 0); ratio change = 50/400 = 0.125
    // New ratio = 0.5 + 0.125 = 0.625
    dispatchPointerMove(50);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBeCloseTo(0.625);
    dispatchPointerUp();
  });

  // T6: clamp to min via store setter
  it("T6: large negative delta → ratio clamped to TAGS_PANEL_RATIO_MIN (0.2) by store setter", () => {
    useTreeStore.setState({ tagsPanelHeightRatio: 0.25 }); // near min
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("resize-handle"));
    // Negative delta: lastPosRef=0, move to clientY that would push below min
    // Actually, dispatch a negative-Y move. Since lastPosRef=0, a clientY=-100
    // gives delta=-100, ratio=0.25+(-100/400)=0.25-0.25=0.0 → clamped to 0.2
    document.dispatchEvent(
      new MouseEvent("pointermove", { clientY: -100, bubbles: true }),
    );
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(TAGS_PANEL_RATIO_MIN);
    dispatchPointerUp();
  });

  // T7: clamp to max via store setter
  it("T7: large positive delta → ratio clamped to TAGS_PANEL_RATIO_MAX (0.8) by store setter", () => {
    useTreeStore.setState({ tagsPanelHeightRatio: 0.75 }); // near max
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("resize-handle"));
    // Delta=100, ratio=0.75+0.25=1.0 → clamped to 0.8
    dispatchPointerMove(100);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(TAGS_PANEL_RATIO_MAX);
    dispatchPointerUp();
  });

  // T8: pointerup stops drag
  it("T8: pointerup stops dragging — subsequent pointermove no longer updates store", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("resize-handle"));
    dispatchPointerMove(40); // ratio = 0.5 + 40/400 = 0.6
    const ratioAfterDrag = useTreeStore.getState().tagsPanelHeightRatio;
    dispatchPointerUp();
    // After pointerup, drag is done — further moves must not update the store.
    dispatchPointerMove(100);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(ratioAfterDrag); // unchanged
  });

  // T9: unmount mid-drag removes document listeners
  it("T9: unmount mid-drag removes document pointermove + pointerup listeners", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { getByTestId, unmount } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("resize-handle"));
    // Now unmount while dragging
    unmount();
    const removedEventNames = removeSpy.mock.calls.map((c) => c[0]);
    expect(removedEventNames).toContain("pointermove");
    expect(removedEventNames).toContain("pointerup");
    removeSpy.mockRestore();
  });

  // T10: transparent background (D-12/D-14 — no visible band)
  it("T10: rendered handle has transparent background (D-12: cursor-only, no 4px band)", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    const handle = getByTestId("resize-handle");
    expect(handle.style.background).toBe("transparent");
  });

  // T11: no pointermove/pointerdown handlers directly on InterPanelDivider (all delegated)
  it("T11: renders cursor row-resize (horizontal orientation delegated to ResizeHandle)", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    const handle = getByTestId("resize-handle");
    expect(handle.style.cursor).toBe("row-resize");
  });
});

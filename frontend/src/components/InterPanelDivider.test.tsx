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


function dispatchPointerMove(clientY: number) {
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


describe("<InterPanelDivider /> — Phase 6.5 UX-T-01 / Phase 6.6 UX-CHROME-04 delegation", () => {
  beforeEach(() => {
    useTreeStore.setState({ tagsPanelHeightRatio: 0.5 });
  });

  afterEach(() => {
    dispatchPointerUp();
    useTreeStore.setState({ tagsPanelHeightRatio: 0.5 });
  });

  it("T1: renders with role=separator, aria-orientation=horizontal, aria-label='Resize panels'", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    const handle = getByTestId("inter-panel-divider");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.getAttribute("aria-label")).toBe("Resize panels");
  });

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

  it("T3: pointerdown activates drag — pointermove updates ratio", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    const handle = getByTestId("inter-panel-divider");
    fireEvent.pointerDown(handle);
    dispatchPointerMove(100);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBeCloseTo(0.75);
    dispatchPointerUp();
  });

  it("T4: pointermove while not dragging does NOT update store ratio", () => {
    renderDivider({ top: 0, height: 400 });
    dispatchPointerMove(200);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(0.5);
  });

  it("T5: pointerdown then pointermove clientY=50 over {height:400} → ratio increases by 50/400=0.125", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("inter-panel-divider"));
    dispatchPointerMove(50);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBeCloseTo(0.625);
    dispatchPointerUp();
  });

  it("T6: large negative delta → ratio clamped to TAGS_PANEL_RATIO_MIN (0.2) by store setter", () => {
    useTreeStore.setState({ tagsPanelHeightRatio: 0.25 });
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("inter-panel-divider"));
    document.dispatchEvent(
      new MouseEvent("pointermove", { clientY: -100, bubbles: true }),
    );
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(TAGS_PANEL_RATIO_MIN);
    dispatchPointerUp();
  });

  it("T7: large positive delta → ratio clamped to TAGS_PANEL_RATIO_MAX (0.8) by store setter", () => {
    useTreeStore.setState({ tagsPanelHeightRatio: 0.75 });
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("inter-panel-divider"));
    dispatchPointerMove(100);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(TAGS_PANEL_RATIO_MAX);
    dispatchPointerUp();
  });

  it("T8: pointerup stops dragging — subsequent pointermove no longer updates store", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("inter-panel-divider"));
    dispatchPointerMove(40);
    const ratioAfterDrag = useTreeStore.getState().tagsPanelHeightRatio;
    dispatchPointerUp();
    dispatchPointerMove(100);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBe(ratioAfterDrag);
  });

  it("T9: unmount mid-drag removes document pointermove + pointerup listeners", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { getByTestId, unmount } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("inter-panel-divider"));
    unmount();
    const removedEventNames = removeSpy.mock.calls.map((c) => c[0]);
    expect(removedEventNames).toContain("pointermove");
    expect(removedEventNames).toContain("pointerup");
    removeSpy.mockRestore();
  });

  it("T10: rendered handle has transparent background (D-12: cursor-only, no 4px band)", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    const handle = getByTestId("inter-panel-divider");
    expect(handle.style.background).toBe("transparent");
  });

  it("T11: renders cursor row-resize (horizontal orientation delegated to ResizeHandle)", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    const handle = getByTestId("inter-panel-divider");
    expect(handle.style.cursor).toBe("row-resize");
  });

  it("T12: cumulative pointermove deltas within one drag accumulate against fresh ratio", () => {
    const { getByTestId } = renderDivider({ top: 0, height: 400 });
    fireEvent.pointerDown(getByTestId("inter-panel-divider"));
    dispatchPointerMove(20);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBeCloseTo(0.55);
    dispatchPointerMove(40);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBeCloseTo(0.6);
    dispatchPointerMove(60);
    expect(useTreeStore.getState().tagsPanelHeightRatio).toBeCloseTo(0.65);
    dispatchPointerUp();
  });
});

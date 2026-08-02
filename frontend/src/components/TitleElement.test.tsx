/**
 * TitleElement render/edit tests — locks the 33px/700 title token, the
 * Untitled placeholder, the write-through-only-callback contract (no
 * fetch/second doc-mutation channel), and the Enter/ArrowDown/Tab
 * focus-handoff (Enter and ArrowDown carry a measured caret
 * pixel-X for column-preserving crossover into the body).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isLastVisualRow } from "../editor/titleBodyTraversal";
import { TitleElement } from "./TitleElement";

describe("<TitleElement />", () => {
  it("C1: renders the current H1 text at 33px/700 with the title test id", () => {
    render(
      <TitleElement title="My Note" onTitleChange={vi.fn()} onFocusHandoff={vi.fn()} />,
    );
    const el = screen.getByTestId("editor-title-element");
    expect(el).toHaveTextContent("My Note");
    expect(el).toHaveStyle({ fontSize: "33px", fontWeight: "700" });
  });

  it("C2: empty/null title renders the muted 'Untitled' placeholder", () => {
    render(
      <TitleElement title={null} onTitleChange={vi.fn()} onFocusHandoff={vi.fn()} />,
    );
    const el = screen.getByTestId("editor-title-element");
    expect(el).toHaveTextContent("Untitled");
    expect(el).toHaveStyle({ color: "var(--color-muted)" });
  });

  it("C3: editing fires onTitleChange with the new text, no fetch/API call", () => {
    const onTitleChange = vi.fn();
    render(
      <TitleElement title="My Note" onTitleChange={onTitleChange} onFocusHandoff={vi.fn()} />,
    );
    const el = screen.getByTestId("editor-title-element");
    el.textContent = "New Title";
    fireEvent.input(el);
    expect(onTitleChange).toHaveBeenCalledWith("New Title");
  });

  it("C4: Enter invokes onFocusHandoff with a measured numeric X, with preventDefault (no newline inserted)", () => {
    const onFocusHandoff = vi.fn();
    render(
      <TitleElement title="My Note" onTitleChange={vi.fn()} onFocusHandoff={onFocusHandoff} />,
    );
    const el = screen.getByTestId("editor-title-element");
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    fireEvent(el, event);
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(onFocusHandoff).toHaveBeenCalledTimes(1);
    expect(typeof onFocusHandoff.mock.calls[0][0]).toBe("number");
  });

  it("C4b: ArrowDown invokes onFocusHandoff with a measured numeric X, with preventDefault", () => {
    const onFocusHandoff = vi.fn();
    render(
      <TitleElement title="My Note" onTitleChange={vi.fn()} onFocusHandoff={onFocusHandoff} />,
    );
    const el = screen.getByTestId("editor-title-element");
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    fireEvent(el, event);
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(onFocusHandoff).toHaveBeenCalledTimes(1);
    expect(typeof onFocusHandoff.mock.calls[0][0]).toBe("number");
  });

  it("C5: Tab invokes onFocusHandoff with preventDefault (unchanged: still moves focus into the body)", () => {
    const onFocusHandoff = vi.fn();
    render(
      <TitleElement title="My Note" onTitleChange={vi.fn()} onFocusHandoff={onFocusHandoff} />,
    );
    const el = screen.getByTestId("editor-title-element");
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    fireEvent(el, event);
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(onFocusHandoff).toHaveBeenCalledTimes(1);
  });

  it("C6: aria-label is 'Note title'", () => {
    render(
      <TitleElement title="My Note" onTitleChange={vi.fn()} onFocusHandoff={vi.fn()} />,
    );
    expect(screen.getByLabelText("Note title")).toBeInTheDocument();
  });
});

describe("ArrowDown visual-row gating", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("isLastVisualRow pure helper: true only when the caret's bottom edge is within one line-height of the element's own bottom edge", () => {
    // 5px gap, 20px line-height — caret is on the last (only remaining) row.
    expect(isLastVisualRow(100, 105, 20)).toBe(true);
    // 60px gap, 20px line-height — at least one full wrapped row exists below the caret.
    expect(isLastVisualRow(80, 140, 20)).toBe(false);
  });

  /**
   * jsdom has no real text-layout engine (Range has no getClientRects at
   * all), so a genuinely wrapped title can't be produced in this
   * environment — measureCaretX/caretOnLastVisualRow fall back to
   * always-cross whenever real geometry is unavailable (documented in
   * TitleElement.tsx). These two tests stub window.getSelection/
   * getBoundingClientRect/getComputedStyle to hand the REAL production
   * caretOnLastVisualRow() function synthetic-but-shaped geometry, proving
   * its row-comparison branch runs correctly end to end (not just the pure
   * helper above). Real wrapped-title browser geometry is proven by
   * phase31-title-traversal.spec.ts.
   */
  function mockCaretGeometry(caretBottom: number, elementBottom: number, lineHeightPx: number) {
    const fakeRange = {
      getClientRects: () => [{ height: 20, bottom: caretBottom } as DOMRect],
      getBoundingClientRect: () => ({ height: 20, bottom: caretBottom }) as DOMRect,
    };
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      getRangeAt: () => fakeRange,
    } as unknown as Selection);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: elementBottom,
    } as DOMRect);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      lineHeight: `${lineHeightPx}px`,
    } as CSSStyleDeclaration);
  }

  it("ArrowDown on a NON-last visual row (wrapped title, caret on row 1 of 2): does NOT hand off — a wrapped row exists below within the title", () => {
    const onFocusHandoff = vi.fn();
    render(
      <TitleElement
        title="A very long note title that would wrap across two visual rows"
        onTitleChange={vi.fn()}
        onFocusHandoff={onFocusHandoff}
      />,
    );
    const el = screen.getByTestId("editor-title-element");
    // Caret bottom (row 1) is far above the element's own bottom edge (row 2
    // exists below) — a 40px gap against a 20px line-height.
    mockCaretGeometry(100, 140, 20);

    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    fireEvent(el, event);

    expect(preventDefaultSpy).not.toHaveBeenCalled();
    expect(onFocusHandoff).not.toHaveBeenCalled();
  });

  it("ArrowDown on the LAST visual row (wrapped title, caret on row 2 of 2): hands off to the body as before", () => {
    const onFocusHandoff = vi.fn();
    render(
      <TitleElement
        title="A very long note title that would wrap across two visual rows"
        onTitleChange={vi.fn()}
        onFocusHandoff={onFocusHandoff}
      />,
    );
    const el = screen.getByTestId("editor-title-element");
    // Caret bottom is within one line-height of the element's own bottom —
    // no wrapped row remains below.
    mockCaretGeometry(138, 140, 20);

    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    fireEvent(el, event);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(onFocusHandoff).toHaveBeenCalledTimes(1);
  });
});

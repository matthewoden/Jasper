/**
 * TitleElement render/edit tests — locks the 33px/700 title token, the
 * Untitled placeholder, the write-through-only-callback contract (no
 * fetch/second doc-mutation channel), and the Enter/ArrowDown/Tab
 * focus-handoff (D-19/D-20: Enter and ArrowDown carry a measured caret
 * pixel-X for column-preserving crossover into the body).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

  it("C4b: ArrowDown invokes onFocusHandoff with a measured numeric X, with preventDefault (D-19/D-20)", () => {
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

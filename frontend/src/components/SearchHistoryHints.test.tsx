import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchHistoryHints } from "./SearchHistoryHints";
import { initForVault, recordSearchHistory } from "../lib/searchHistory";

beforeEach(() => {
  window.localStorage.clear();
  initForVault("/vault/hints-test");
});

describe("SearchHistoryHints", () => {
  it("renders nothing when history is empty", () => {
    const { container } = render(
      <SearchHistoryHints query="" activeIndex={-1} onSelectHint={() => {}} onRemoveHint={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when no entries prefix-match the query", () => {
    recordSearchHistory("weekly sync");
    const { container } = render(
      <SearchHistoryHints
        query="zzz"
        activeIndex={-1}
        onSelectHint={() => {}}
        onRemoveHint={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("filters to prefix matches, MRU order", () => {
    recordSearchHistory("meeting notes");
    recordSearchHistory("weekly sync");
    recordSearchHistory("meet the team");
    render(
      <SearchHistoryHints
        query="meet"
        activeIndex={-1}
        onSelectHint={() => {}}
        onRemoveHint={() => {}}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain("meet the team");
    expect(options[1].textContent).toContain("meeting notes");
  });

  it("each row shows a Clock glyph and the query text as plain text (no dangerouslySetInnerHTML anywhere in the file)", () => {
    recordSearchHistory("hello world");
    const { container } = render(
      <SearchHistoryHints query="" activeIndex={-1} onSelectHint={() => {}} onRemoveHint={() => {}} />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(screen.getByText("hello world")).toBeDefined();
  });

  it("clicking a row calls onSelectHint with the query", () => {
    recordSearchHistory("hello world");
    const onSelectHint = vi.fn();
    render(
      <SearchHistoryHints
        query=""
        activeIndex={-1}
        onSelectHint={onSelectHint}
        onRemoveHint={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("option"));
    expect(onSelectHint).toHaveBeenCalledWith("hello world");
  });

  it("clicking the x calls onRemoveHint without triggering onSelectHint", () => {
    recordSearchHistory("hello world");
    const onSelectHint = vi.fn();
    const onRemoveHint = vi.fn();
    render(
      <SearchHistoryHints
        query=""
        activeIndex={-1}
        onSelectHint={onSelectHint}
        onRemoveHint={onRemoveHint}
      />,
    );
    fireEvent.click(screen.getByLabelText('Remove "hello world" from search history'));
    expect(onRemoveHint).toHaveBeenCalledWith("hello world");
    expect(onSelectHint).not.toHaveBeenCalled();
  });

  it("applies the accent-12% tint to the row at activeIndex", () => {
    recordSearchHistory("alpha");
    recordSearchHistory("beta");
    render(
      <SearchHistoryHints query="" activeIndex={0} onSelectHint={() => {}} onRemoveHint={() => {}} />,
    );
    const options = screen.getAllByRole("option");
    expect(options[0].style.background).toContain("color-mix");
    expect(options[0].style.background).toContain("var(--color-accent)");
    expect(options[0].style.background).toContain("12%");
    expect(options[1].style.background).not.toContain("var(--color-accent)");
  });
});

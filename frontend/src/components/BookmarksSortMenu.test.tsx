/**
 * BookmarksSortMenu tests — mirrors NotesSortMenu.test.tsx, plus the
 * seventh "Manual" order that has no notes-tree counterpart.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { BookmarksSortMenu } from "./BookmarksSortMenu";
import { TooltipProvider } from "./Tooltip";
import type { BookmarksSortOrder } from "../lib/useTreeStore";

function renderMenu(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const ALL_ORDERS: BookmarksSortOrder[] = [
  "manual",
  "name-asc",
  "name-desc",
  "modified-desc",
  "modified-asc",
  "created-desc",
  "created-asc",
];

const LABELS: Record<BookmarksSortOrder, string> = {
  manual: "Manual",
  "name-asc": "Name (A → Z)",
  "name-desc": "Name (Z → A)",
  "modified-desc": "Modified (new → old)",
  "modified-asc": "Modified (old → new)",
  "created-desc": "Created (new → old)",
  "created-asc": "Created (old → new)",
};

describe("<BookmarksSortMenu /> — item rendering", () => {
  it("renders all seven labeled items", () => {
    renderMenu(
      <BookmarksSortMenu value="manual" onSelect={vi.fn()} open={true} />,
    );
    for (const order of ALL_ORDERS) {
      expect(screen.getByText(LABELS[order])).toBeInTheDocument();
    }
  });

  it("lists Manual first", () => {
    renderMenu(
      <BookmarksSortMenu value="manual" onSelect={vi.fn()} open={true} />,
    );
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    expect(items[0]?.textContent).toContain("Manual");
  });

  it("checkmarks only the active order", () => {
    renderMenu(
      <BookmarksSortMenu value="created-desc" onSelect={vi.fn()} open={true} />,
    );
    const active = screen
      .getByText(LABELS["created-desc"])
      .closest('[role="menuitem"]');
    expect(active?.querySelector("svg")).not.toBeNull();

    for (const order of ALL_ORDERS) {
      if (order === "created-desc") continue;
      const item = screen.getByText(LABELS[order]).closest('[role="menuitem"]');
      expect(item?.querySelector("svg")).toBeNull();
    }
  });

  it("fires onSelect with the chosen order", () => {
    const onSelect = vi.fn();
    renderMenu(
      <BookmarksSortMenu value="manual" onSelect={onSelect} open={true} />,
    );

    fireEvent.click(screen.getByText(LABELS["modified-asc"]));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("modified-asc");
  });

  it("labels the trigger 'Sort bookmarks'", () => {
    renderMenu(<BookmarksSortMenu value="manual" onSelect={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Sort bookmarks", hidden: true }),
    ).toBeInTheDocument();
  });

  it("accents the trigger while open and mutes it while closed", () => {
    const { unmount } = renderMenu(
      <BookmarksSortMenu value="manual" onSelect={vi.fn()} open={true} />,
    );
    expect(
      screen.getByRole("button", { name: "Sort bookmarks", hidden: true }).style
        .color,
    ).toBe("var(--color-accent)");
    unmount();

    renderMenu(
      <BookmarksSortMenu value="manual" onSelect={vi.fn()} open={false} />,
    );
    expect(
      screen.getByRole("button", { name: "Sort bookmarks" }).style.color,
    ).toBe("var(--color-muted)");
  });
});

describe("<BookmarksSortMenu /> — constant trigger glyph", () => {
  /**
   * The order-reflecting trigger was shipped, verified, then reversed by
   * owner feedback on the notes tree; bookmarks must not reintroduce it.
   */
  const CONSTANT_GLYPH_CLASS = "lucide-arrow-up-down";

  it("renders the same constant glyph across every order", () => {
    for (const order of ALL_ORDERS) {
      const { unmount } = renderMenu(
        <BookmarksSortMenu value={order} onSelect={vi.fn()} />,
      );
      const trigger = screen.getByRole("button", { name: "Sort bookmarks" });
      expect(trigger.querySelector("svg")).toHaveClass(CONSTANT_GLYPH_CLASS);
      unmount();
    }
  });
});

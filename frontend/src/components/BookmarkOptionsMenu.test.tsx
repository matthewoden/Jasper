/**
 * The bookmark row ⋯ menu mirrors NoteOptionsMenu's item set and adds the two
 * bookmark-specific entries.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const revealInNavigationMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/revealInNavigation", () => ({
  revealInNavigation: revealInNavigationMock,
}));

import { BookmarkOptionsMenu, BookmarkRowContextMenu } from "./BookmarkOptionsMenu";
import { TooltipProvider } from "./Tooltip";

const ITEM_ORDER = [
  "Rename",
  "Move to…",
  "Remove bookmark",
  "Move to bookmark folder",
  "Split right",
  "Split down",
  "Find",
  "Replace",
  "Reveal in navigation",
  "Show in file manager",
  "Delete",
];

function makeHandlers() {
  return {
    onRequestRename: vi.fn(),
    onMove: vi.fn(),
    onSplit: vi.fn(),
    onDelete: vi.fn(),
    onRemoveBookmark: vi.fn(),
    onMoveToBookmarkFolder: vi.fn(),
    onNewBookmarkFolder: vi.fn(),
    onOpenFind: vi.fn(),
    onOpenFindReplace: vi.fn(),
    onRevealInFileManager: vi.fn(),
  };
}

function renderMenu(handlers = makeHandlers()) {
  render(
    <TooltipProvider>
      <BookmarkOptionsMenu
        noteId="note-1"
        folders={[{ id: "f1", name: "Work" }]}
        open
        {...handlers}
      />
    </TooltipProvider>,
  );
  return handlers;
}

describe("BookmarkOptionsMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders every note-menu item plus the bookmark-specific pair, in order", () => {
    renderMenu();
    const labels = screen
      .getAllByRole("menuitem")
      .map((el) => el.textContent?.trim());
    expect(labels).toEqual(ITEM_ORDER);
  });

  it("labels the trigger for assistive tech", () => {
    renderMenu();
    expect(screen.getByLabelText("Bookmark options")).toBeTruthy();
  });

  it.each([
    ["Rename", "onRequestRename"],
    ["Move to…", "onMove"],
    ["Remove bookmark", "onRemoveBookmark"],
    ["Find", "onOpenFind"],
    ["Replace", "onOpenFindReplace"],
    ["Show in file manager", "onRevealInFileManager"],
    ["Delete", "onDelete"],
  ] as const)("dispatches %s to %s", async (label, handlerName) => {
    const handlers = renderMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: label }));
    expect(handlers[handlerName]).toHaveBeenCalledTimes(1);
  });

  it("splits right and down with the matching direction", async () => {
    const handlers = renderMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "Split right" }));
    expect(handlers.onSplit).toHaveBeenCalledWith("row");
    await userEvent.click(screen.getByRole("menuitem", { name: "Split down" }));
    expect(handlers.onSplit).toHaveBeenCalledWith("col");
  });

  it("reveals the bookmarked note in the navigation tree", async () => {
    renderMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Reveal in navigation" }),
    );
    expect(revealInNavigationMock).toHaveBeenCalledWith("note-1");
  });

  it("styles Remove bookmark and Delete as destructive", () => {
    renderMenu();
    for (const label of ["Remove bookmark", "Delete"]) {
      const item = screen.getByRole("menuitem", { name: label });
      expect(item.getAttribute("style")).toContain("--color-destructive");
    }
  });

  it("offers top level, every folder and a new-folder escape in the move submenu", async () => {
    const handlers = renderMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Move to bookmark folder" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "(No folder)" }));
    expect(handlers.onMoveToBookmarkFolder).toHaveBeenCalledWith(null);

    await userEvent.click(
      screen.getByRole("menuitem", { name: "Move to bookmark folder" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    expect(handlers.onMoveToBookmarkFolder).toHaveBeenCalledWith("f1");

    await userEvent.click(
      screen.getByRole("menuitem", { name: "Move to bookmark folder" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "New folder…" }));
    expect(handlers.onNewBookmarkFolder).toHaveBeenCalledTimes(1);
  });

  it("opens from the keyboard and moves focus into the item list", async () => {
    const handlers = makeHandlers();
    render(
      <TooltipProvider>
        <BookmarkOptionsMenu noteId="note-1" folders={[]} {...handlers} />
      </TooltipProvider>,
    );
    const trigger = screen.getByLabelText("Bookmark options");
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
  });
});

describe("BookmarkRowContextMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers the same item set on right-click", async () => {
    const handlers = makeHandlers();
    render(
      <TooltipProvider>
        <BookmarkRowContextMenu noteId="note-1" folders={[]} {...handlers}>
          <div data-testid="row">Alpha</div>
        </BookmarkRowContextMenu>
      </TooltipProvider>,
    );
    await userEvent.pointer({
      target: screen.getByTestId("row"),
      keys: "[MouseRight]",
    });
    const labels = screen
      .getAllByRole("menuitem")
      .map((el) => el.textContent?.trim());
    expect(labels).toEqual(ITEM_ORDER);
  });
});

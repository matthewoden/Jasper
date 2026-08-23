/**
 * The bookmark-folder ⋯ menu: rename + delete only. Delete is destructive
 * because it removes the grouping label, not because it removes bookmarks —
 * the bookmarks inside survive at top level.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BookmarkFolderContextMenu,
  BookmarkFolderOptionsMenu,
} from "./BookmarkFolderOptionsMenu";
import { TooltipProvider } from "./Tooltip";

const ITEM_ORDER = ["Rename folder", "Delete folder"];

describe("BookmarkFolderOptionsMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers exactly rename and delete", () => {
    render(
      <TooltipProvider>
        <BookmarkFolderOptionsMenu open onRename={vi.fn()} onDelete={vi.fn()} />
      </TooltipProvider>,
    );
    const labels = screen
      .getAllByRole("menuitem")
      .map((el) => el.textContent?.trim());
    expect(labels).toEqual(ITEM_ORDER);
  });

  it("labels the trigger for assistive tech", () => {
    render(
      <TooltipProvider>
        <BookmarkFolderOptionsMenu open onRename={vi.fn()} onDelete={vi.fn()} />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Bookmark folder options" }),
    ).toBeTruthy();
  });

  it("dispatches each item to its handler", async () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(
      <TooltipProvider>
        <BookmarkFolderOptionsMenu open onRename={onRename} onDelete={onDelete} />
      </TooltipProvider>,
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename folder" }));
    expect(onRename).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete folder" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("styles Delete folder as destructive", () => {
    render(
      <TooltipProvider>
        <BookmarkFolderOptionsMenu open onRename={vi.fn()} onDelete={vi.fn()} />
      </TooltipProvider>,
    );
    const item = screen.getByRole("menuitem", { name: "Delete folder" });
    expect(item.getAttribute("style")).toContain("--color-destructive");
  });

  it("opens from the keyboard", async () => {
    render(
      <TooltipProvider>
        <BookmarkFolderOptionsMenu onRename={vi.fn()} onDelete={vi.fn()} />
      </TooltipProvider>,
    );
    screen.getByRole("button", { name: "Bookmark folder options" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "Rename folder" })).toBeTruthy();
  });
});

describe("BookmarkFolderContextMenu", () => {
  it("offers the same item set on right-click", async () => {
    render(
      <TooltipProvider>
        <BookmarkFolderContextMenu onRename={vi.fn()} onDelete={vi.fn()}>
          <div data-testid="folder-row">Work</div>
        </BookmarkFolderContextMenu>
      </TooltipProvider>,
    );
    await userEvent.pointer({
      target: screen.getByTestId("folder-row"),
      keys: "[MouseRight]",
    });
    const labels = screen
      .getAllByRole("menuitem")
      .map((el) => el.textContent?.trim());
    expect(labels).toEqual(ITEM_ORDER);
  });
});

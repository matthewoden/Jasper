/**
 * NoteOptionsMenu tests (CTX-03, D-21..D-25 — Phase 30 Plan 09).
 *
 * Verifies the locked D-22 item order, both split directions, Find/Replace
 * delegation, the Bookmark label toggle, and Reveal-in-navigation wiring.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toggleBookmarkMock = vi.hoisted(() => vi.fn());
const bookmarkedNoteIdsRef = vi.hoisted(() => ({ current: new Set<string>() }));
vi.mock("../lib/useBookmarks", () => ({
  useBookmarks: () => ({
    isBookmarked: (noteId: string) => bookmarkedNoteIdsRef.current.has(noteId),
    toggleBookmark: toggleBookmarkMock,
  }),
}));

const revealMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/useReveal", () => ({
  useReveal: () => ({ reveal: revealMock, loading: false }),
}));

const revealInNavigationMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/revealInNavigation", () => ({
  revealInNavigation: revealInNavigationMock,
}));

const deleteNoteMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/useTreeMutations", () => ({
  useTreeMutations: () => ({ deleteNote: deleteNoteMock }),
}));

const splitActivePaneMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/usePaneStore", () => ({
  usePaneStore: {
    getState: () => ({ splitActivePane: splitActivePaneMock }),
  },
}));

vi.mock("../lib/useFileTree", () => ({
  useFileTree: () => ({ tree: null, loading: false, error: null, refresh: vi.fn(), mutate: vi.fn() }),
  walkTreeCollect: vi.fn(() => ({ folders: new Set<string>(), notes: new Set<string>() })),
}));

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("./toast.utils", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { NoteOptionsMenu } from "./NoteOptionsMenu";
import { TooltipProvider } from "./Tooltip";

const LOCKED_ORDER = [
  "Rename",
  "Move to…",
  "Bookmark",
  "Split right",
  "Split down",
  "Find",
  "Replace",
  "Reveal in navigation",
  "Show in file manager",
  "Delete",
];

function renderMenu(overrides?: {
  onOpenFind?: () => void;
  onOpenFindReplace?: () => void;
  onRequestRename?: () => void;
}) {
  const props = {
    noteId: "note-1",
    notePath: "Projects/note.md",
    onOpenFind: overrides?.onOpenFind ?? vi.fn(),
    onOpenFindReplace: overrides?.onOpenFindReplace ?? vi.fn(),
    onRequestRename: overrides?.onRequestRename ?? vi.fn(),
    open: true,
  };
  render(
    <TooltipProvider>
      <NoteOptionsMenu {...props} />
    </TooltipProvider>,
  );
  return props;
}

beforeEach(() => {
  toggleBookmarkMock.mockReset();
  revealMock.mockReset();
  revealInNavigationMock.mockReset();
  deleteNoteMock.mockReset();
  splitActivePaneMock.mockReset();
  toastMock.mockReset();
  bookmarkedNoteIdsRef.current = new Set<string>();
});

describe("<NoteOptionsMenu />", () => {
  it("renders the locked D-22 item order", () => {
    renderMenu();
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(LOCKED_ORDER);
  });

  it("Split right calls splitActivePane('row')", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("menuitem", { name: "Split right" }));
    expect(splitActivePaneMock).toHaveBeenCalledWith("row");
  });

  it("Split down calls splitActivePane('col')", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("menuitem", { name: "Split down" }));
    expect(splitActivePaneMock).toHaveBeenCalledWith("col");
  });

  it("Find calls onOpenFind", async () => {
    const user = userEvent.setup();
    const onOpenFind = vi.fn();
    renderMenu({ onOpenFind });
    await user.click(screen.getByRole("menuitem", { name: "Find" }));
    expect(onOpenFind).toHaveBeenCalledTimes(1);
  });

  it("Replace calls onOpenFindReplace", async () => {
    const user = userEvent.setup();
    const onOpenFindReplace = vi.fn();
    renderMenu({ onOpenFindReplace });
    await user.click(screen.getByRole("menuitem", { name: "Replace" }));
    expect(onOpenFindReplace).toHaveBeenCalledTimes(1);
  });

  it("Rename calls onRequestRename", async () => {
    const user = userEvent.setup();
    const onRequestRename = vi.fn();
    renderMenu({ onRequestRename });
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onRequestRename).toHaveBeenCalledTimes(1);
  });

  it("shows 'Bookmark' when not bookmarked and toggles on click", async () => {
    const user = userEvent.setup();
    renderMenu();
    expect(screen.getByRole("menuitem", { name: "Bookmark" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Bookmark" }));
    expect(toggleBookmarkMock).toHaveBeenCalledWith("note-1");
  });

  it("shows 'Remove bookmark' when the note is already bookmarked", () => {
    bookmarkedNoteIdsRef.current = new Set(["note-1"]);
    renderMenu();
    expect(screen.getByRole("menuitem", { name: "Remove bookmark" })).toBeInTheDocument();
  });

  it("Reveal in navigation calls revealInNavigation with the note id", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("menuitem", { name: "Reveal in navigation" }));
    expect(revealInNavigationMock).toHaveBeenCalledWith("note-1");
  });

  it("Show in file manager calls reveal with the note path", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("menuitem", { name: "Show in file manager" }));
    expect(revealMock).toHaveBeenCalledWith("Projects/note.md");
  });

  it("Delete opens the shared delete-confirm dialog", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByText("Delete note?")).toBeInTheDocument();
  });

  it("the menu container is 210px wide with a 10px border radius", () => {
    renderMenu();
    const menu = screen.getByRole("menu");
    expect(menu).toHaveStyle({ width: "210px", borderRadius: "10px" });
  });
});

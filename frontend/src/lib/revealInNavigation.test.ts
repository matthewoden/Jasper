/**
 * revealInNavigation tests (D-25).
 */
import { describe, expect, it, vi } from "vitest";

const scrollToNoteRowMock = vi.hoisted(() => vi.fn());
vi.mock("../components/fileTree.utils", () => ({
  scrollToNoteRow: scrollToNoteRowMock,
}));

import { revealInNavigation } from "./revealInNavigation";
import { useTreeStore } from "./useTreeStore";

describe("revealInNavigation", () => {
  it("switches the left sidebar to the Notes panel and makes it visible", () => {
    useTreeStore.setState({ sidebarPanel: "search", notesSidebarVisible: false });
    revealInNavigation("note-1");
    expect(useTreeStore.getState().sidebarPanel).toBe("notes");
    expect(useTreeStore.getState().notesSidebarVisible).toBe(true);
  });

  it("scrolls the tree to the note's row", () => {
    scrollToNoteRowMock.mockClear();
    revealInNavigation("note-2");
    expect(scrollToNoteRowMock).toHaveBeenCalledWith("note-2");
  });

  it("sets the pulse target to the note", () => {
    revealInNavigation("note-3");
    expect(useTreeStore.getState().pulseTarget).toEqual({
      kind: "note",
      target: "note-3",
    });
  });
});

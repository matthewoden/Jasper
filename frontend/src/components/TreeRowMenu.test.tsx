/**
 * TreeRowMenu tests — UI-SPEC §Surface 2.
 *
 * Verifies that both <TreeRowContextMenu> and <TreeRowDropdownMenu>
 * variants render the same item set per rowKind, with locked copy +
 * shortcuts, and that onSelect fires the matching callback prop.
 *
 * Radix renders menus into portals; we use the open prop on
 * DropdownMenu to mount content immediately for assertions, and
 * fireEvent.contextMenu for the ContextMenu trigger.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  TreeRowContextMenu,
  TreeRowDropdownMenu,
} from "./TreeRowMenu";

describe("<TreeRowDropdownMenu /> — item rendering by rowKind", () => {
  it("TestMenu_NoteRow_HasOpen", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("TestMenu_NoteRow_HasRenameShortcut", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("F2")).toBeInTheDocument();
  });

  it("TestMenu_NoteRow_HasDeleteShortcut", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.getByText("⌫")).toBeInTheDocument();
  });

  it("TestMenu_FolderRow_NoOpen", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="folder"
        parentPath="projects"
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    expect(screen.queryByText("Open")).toBeNull();
  });

  it("TestMenu_FolderRow_HasNewFolder", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="folder"
        parentPath="projects"
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    expect(screen.getByText("New folder")).toBeInTheDocument();
  });

  it("TestMenu_EmptyArea_OnlyTwoItems", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="empty-area"
        parentPath=""
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    expect(screen.getByText("New note")).toBeInTheDocument();
    expect(screen.getByText("New folder")).toBeInTheDocument();
    expect(screen.queryByText("Rename")).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();
    expect(screen.queryByText("Open")).toBeNull();
  });

  it("TestMenu_OnNewNote_Triggered", () => {
    const onNewNote = vi.fn();
    render(
      <TreeRowDropdownMenu
        rowKind="folder"
        parentPath="projects"
        onNewNote={onNewNote}
        onNewFolder={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    fireEvent.click(screen.getByText("New note"));
    expect(onNewNote).toHaveBeenCalledTimes(1);
  });

  it("TestMenu_OnRename_Triggered", () => {
    const onRename = vi.fn();
    render(
      <TreeRowDropdownMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={onRename}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    fireEvent.click(screen.getByText("Rename"));
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("TestMenu_OnDelete_Triggered", () => {
    const onDelete = vi.fn();
    render(
      <TreeRowDropdownMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={onDelete}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("TestMenu_DestructiveItem_HasDestructiveColor", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    const deleteText = screen.getByText("Delete");
    let el: HTMLElement | null = deleteText;
    let foundDestructive = false;
    while (el) {
      const color = el.style?.color ?? "";
      if (color.includes("destructive") || color.includes("--color-destructive")) {
        foundDestructive = true;
        break;
      }
      el = el.parentElement;
    }
    expect(foundDestructive).toBe(true);
  });
});


describe("<TreeRowMenu /> — UX-12 stopPropagation defense (Pitfall 7)", () => {
  it("UX-12: New note onSelect calls event.stopPropagation()", () => {
    const onNewNote = vi.fn();
    render(
      <TreeRowDropdownMenu
        rowKind="folder"
        parentPath="projects"
        onNewNote={onNewNote}
        onNewFolder={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    const item = screen.getByText("New note").closest('[role="menuitem"]');
    expect(item).not.toBeNull();
    const stopSpy = vi.spyOn(Event.prototype, "stopPropagation");
    try {
      fireEvent.click(item as HTMLElement);
      expect(stopSpy).toHaveBeenCalled();
      expect(onNewNote).toHaveBeenCalledTimes(1);
    } finally {
      stopSpy.mockRestore();
    }
  });

  it("UX-12: New folder onSelect calls event.stopPropagation()", () => {
    const onNewFolder = vi.fn();
    render(
      <TreeRowDropdownMenu
        rowKind="folder"
        parentPath="projects"
        onNewNote={vi.fn()}
        onNewFolder={onNewFolder}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    const item = screen.getByText("New folder").closest('[role="menuitem"]');
    expect(item).not.toBeNull();
    const stopSpy = vi.spyOn(Event.prototype, "stopPropagation");
    try {
      fireEvent.click(item as HTMLElement);
      expect(stopSpy).toHaveBeenCalled();
      expect(onNewFolder).toHaveBeenCalledTimes(1);
    } finally {
      stopSpy.mockRestore();
    }
  });

  it("UX-12: Rename onSelect does NOT call stopPropagation (existing behavior preserved)", () => {
    const onRename = vi.fn();
    render(
      <TreeRowDropdownMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={onRename}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    const item = screen.getByText("Rename").closest('[role="menuitem"]');
    expect(item).not.toBeNull();
    const stopSpy = vi.spyOn(Event.prototype, "stopPropagation");
    try {
      fireEvent.click(item as HTMLElement);
      expect(stopSpy).not.toHaveBeenCalled();
      expect(onRename).toHaveBeenCalledTimes(1);
    } finally {
      stopSpy.mockRestore();
    }
  });
});


describe("<TreeRowDropdownMenu /> — file rowKind (Plan 07-38 R7b)", () => {
  it("TestMenu_FileRow_HasRename", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="file"
        parentPath="attachments"
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("F2")).toBeInTheDocument();
  });

  it("TestMenu_FileRow_HasDelete", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="file"
        parentPath="attachments"
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.getByText("⌫")).toBeInTheDocument();
  });

  it("TestMenu_FileRow_NoOpen", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="file"
        parentPath=""
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    expect(screen.queryByText("Open")).toBeNull();
  });

  it("TestMenu_FileRow_NoNewNote_NoNewFolder", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="file"
        parentPath=""
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    expect(screen.queryByText("New note")).toBeNull();
    expect(screen.queryByText("New folder")).toBeNull();
  });

  it("TestMenu_FileRow_OnRename_Triggered", () => {
    const onRename = vi.fn();
    render(
      <TreeRowDropdownMenu
        rowKind="file"
        parentPath=""
        onNewNote={vi.fn()}
        onRename={onRename}
        onDelete={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    fireEvent.click(screen.getByText("Rename"));
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("TestMenu_FileRow_OnDelete_Triggered", () => {
    const onDelete = vi.fn();
    render(
      <TreeRowDropdownMenu
        rowKind="file"
        parentPath=""
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={onDelete}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe("<TreeRowDropdownMenu /> — note-row locked order + Open in split + Bookmark (CTX-02, D-13/D-17)", () => {
  it("TestMenu_NoteRow_LockedOrder_OpenSplitRevealNewNoteBookmarkRenameDelete", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onReveal={vi.fn()}
        onOpenInSplit={vi.fn()}
        isBookmarked={false}
        onToggleBookmark={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    const openIdx = items.findIndex((t) => t === "Open");
    const splitIdx = items.findIndex((t) => t === "Open in split");
    const revealIdx = items.findIndex((t) => t === "Show in file manager");
    const newNoteIdx = items.findIndex((t) => t === "New note");
    const bookmarkIdx = items.findIndex((t) => t === "Bookmark");
    const renameIdx = items.findIndex((t) => t?.startsWith("Rename"));
    const deleteIdx = items.findIndex((t) => t?.startsWith("Delete"));
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeLessThan(splitIdx);
    expect(splitIdx).toBeLessThan(revealIdx);
    expect(revealIdx).toBeLessThan(newNoteIdx);
    expect(newNoteIdx).toBeLessThan(bookmarkIdx);
    expect(bookmarkIdx).toBeLessThan(renameIdx);
    expect(renameIdx).toBeLessThan(deleteIdx);
  });

  it("TestMenu_NoteRow_Bookmark_ReadsBookmarkWhenNotBookmarked", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        isBookmarked={false}
        onToggleBookmark={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    expect(screen.getByText("Bookmark")).toBeInTheDocument();
    expect(screen.queryByText("Remove bookmark")).toBeNull();
  });

  it("TestMenu_NoteRow_Bookmark_ReadsRemoveBookmarkWhenBookmarked", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        isBookmarked={true}
        onToggleBookmark={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    expect(screen.getByText("Remove bookmark")).toBeInTheDocument();
    expect(screen.queryByText(/^Bookmark$/)).toBeNull();
  });

  it("TestMenu_NoteRow_OnOpenInSplit_Triggered", () => {
    const onOpenInSplit = vi.fn();
    render(
      <TreeRowDropdownMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onOpenInSplit={onOpenInSplit}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    fireEvent.click(screen.getByText("Open in split"));
    expect(onOpenInSplit).toHaveBeenCalledTimes(1);
  });

  it("TestMenu_NoteRow_OnToggleBookmark_Triggered", () => {
    const onToggleBookmark = vi.fn();
    render(
      <TreeRowDropdownMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        isBookmarked={false}
        onToggleBookmark={onToggleBookmark}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    fireEvent.click(screen.getByText("Bookmark"));
    expect(onToggleBookmark).toHaveBeenCalledTimes(1);
  });

  it("TestMenu_FolderRow_HasRevealBelowNewFolder (pre-existing, unchanged by this plan)", () => {
    render(
      <TreeRowDropdownMenu
        rowKind="folder"
        parentPath="projects"
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onReveal={vi.fn()}
        open={true}
      >
        <button>trigger</button>
      </TreeRowDropdownMenu>,
    );
    expect(screen.getByText("Show in file manager")).toBeInTheDocument();
  });
});

describe("<TreeRowContextMenu /> — bulk-selection variant (D-19, selectionCount > 1)", () => {
  it("TestMenu_Bulk_RendersExactlyFourItems_HidesRenameAndReveal", () => {
    render(
      <TreeRowContextMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onReveal={vi.fn()}
        selectionCount={3}
        onBulkOpenTabs={vi.fn()}
        onBulkOpenInSplit={vi.fn()}
        onBulkBookmark={vi.fn()}
        onBulkDelete={vi.fn()}
      >
        <div data-testid="row">row</div>
      </TreeRowContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("row"));
    expect(screen.getByText("Open (3 tabs)")).toBeInTheDocument();
    expect(screen.getByText("Open in split")).toBeInTheDocument();
    expect(screen.getByText("Bookmark 3 notes")).toBeInTheDocument();
    expect(screen.getByText("Delete 3 notes")).toBeInTheDocument();
    expect(screen.queryByText("Rename")).toBeNull();
    expect(screen.queryByText("Show in file manager")).toBeNull();
    expect(screen.queryByText("Open", { exact: true })).toBeNull();
    expect(screen.queryByText("New note")).toBeNull();
  });

  it("TestMenu_Bulk_OnBulkOpenTabs_Triggered", () => {
    const onBulkOpenTabs = vi.fn();
    render(
      <TreeRowContextMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        selectionCount={2}
        onBulkOpenTabs={onBulkOpenTabs}
      >
        <div data-testid="row">row</div>
      </TreeRowContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("row"));
    fireEvent.click(screen.getByText("Open (2 tabs)"));
    expect(onBulkOpenTabs).toHaveBeenCalledTimes(1);
  });

  it("TestMenu_Bulk_OnBulkOpenInSplit_Triggered", () => {
    const onBulkOpenInSplit = vi.fn();
    render(
      <TreeRowContextMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        selectionCount={2}
        onBulkOpenInSplit={onBulkOpenInSplit}
      >
        <div data-testid="row">row</div>
      </TreeRowContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("row"));
    fireEvent.click(screen.getByText("Open in split"));
    expect(onBulkOpenInSplit).toHaveBeenCalledTimes(1);
  });

  it("TestMenu_Bulk_OnBulkBookmark_Triggered", () => {
    const onBulkBookmark = vi.fn();
    render(
      <TreeRowContextMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        selectionCount={4}
        onBulkBookmark={onBulkBookmark}
      >
        <div data-testid="row">row</div>
      </TreeRowContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("row"));
    fireEvent.click(screen.getByText("Bookmark 4 notes"));
    expect(onBulkBookmark).toHaveBeenCalledTimes(1);
  });

  it("TestMenu_Bulk_OnBulkDelete_Triggered", () => {
    const onBulkDelete = vi.fn();
    render(
      <TreeRowContextMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        selectionCount={4}
        onBulkDelete={onBulkDelete}
      >
        <div data-testid="row">row</div>
      </TreeRowContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("row"));
    fireEvent.click(screen.getByText("Delete 4 notes"));
    expect(onBulkDelete).toHaveBeenCalledTimes(1);
  });

  it("TestMenu_SelectionCountOne_RendersNormalSingleTargetMenu_NotBulk", () => {
    render(
      <TreeRowContextMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        selectionCount={1}
      >
        <div data-testid="row">row</div>
      </TreeRowContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("row"));
    expect(screen.getByText("Open", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.queryByText(/Open \(\d+ tabs\)/)).toBeNull();
  });
});

describe("<TreeRowContextMenu /> — right-click trigger", () => {
  it("TestMenu_RightClickTrigger", async () => {
    render(
      <TreeRowContextMenu
        rowKind="note"
        noteId="uuid-1"
        parentPath=""
        onOpen={vi.fn()}
        onNewNote={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      >
        <div data-testid="row">row content</div>
      </TreeRowContextMenu>,
    );
    const row = screen.getByTestId("row");
    fireEvent.contextMenu(row);
    expect(await screen.findByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });
});

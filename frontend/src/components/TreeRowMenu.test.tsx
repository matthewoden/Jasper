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

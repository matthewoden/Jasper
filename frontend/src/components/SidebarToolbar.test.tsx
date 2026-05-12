/**
 * SidebarToolbar tests — Phase 6.6 Plan 10 update.
 *
 * Global controls (ConnectionStatusDot, Refresh, SettingsMenu) have been
 * stripped per D-08. Only note-navigation controls remain:
 *   1. New note (FilePlus)
 *   2. New folder (FolderPlus)
 *
 * The refresh in-flight tests moved to StatusBar.test.tsx.
 * Tests now additionally verify that the removed controls are NOT present.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn().mockResolvedValue({
      data: {
        appName: "Jasper",
        theme: "dark",
        dailyNotes: { folder: "daily", template: "" },
        editor: { fontSize: 15, lineHeight: 1.6, vimMode: false },
      },
      response: { status: 200 },
    }),
    PUT: vi.fn().mockResolvedValue({
      data: {},
      response: { status: 200 },
    }),
  },
}));

import { SidebarToolbar } from "./SidebarToolbar";

describe("<SidebarToolbar /> — note-navigation controls only (Phase 6.6)", () => {
  it("TestToolbar_RendersNewNoteButton", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
  });

  it("TestToolbar_RendersNewFolderButton", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "New folder" })).toBeInTheDocument();
  });

  it("TestToolbar_NewNote_OnClick", () => {
    const onNewNote = vi.fn();
    render(
      <SidebarToolbar
        onNewNote={onNewNote}
        onNewFolder={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(onNewNote).toHaveBeenCalledTimes(1);
  });

  it("TestToolbar_NewFolder_OnClick", () => {
    const onNewFolder = vi.fn();
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={onNewFolder}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect(onNewFolder).toHaveBeenCalledTimes(1);
  });

  it("TestToolbar_NativeTooltips_NewNoteAndNewFolder", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "New note" }).getAttribute("title"),
    ).toBe("New note");
    expect(
      screen.getByRole("button", { name: "New folder" }).getAttribute("title"),
    ).toBe("New folder");
  });

  // ── Gap R2-2: in-flight guard for create buttons ─────────────────────
  it("TestToolbar_CreatingFalse_ButtonsEnabled — default state", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        creating={false}
      />,
    );
    const newNote = screen.getByRole("button", { name: "New note" });
    const newFolder = screen.getByRole("button", { name: "New folder" });
    expect(newNote).not.toBeDisabled();
    expect(newFolder).not.toBeDisabled();
    expect(newNote.style.opacity).not.toBe("0.5");
    expect(newFolder.style.opacity).not.toBe("0.5");
  });

  it("TestToolbar_CreatingTrue_DisablesNewNoteAndNewFolder", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        creating={true}
      />,
    );
    const newNote = screen.getByRole("button", { name: "New note" });
    const newFolder = screen.getByRole("button", { name: "New folder" });
    expect(newNote).toBeDisabled();
    expect(newFolder).toBeDisabled();
    expect(newNote.style.opacity).toBe("0.5");
    expect(newNote.style.cursor).toBe("wait");
    expect(newFolder.style.opacity).toBe("0.5");
    expect(newFolder.style.cursor).toBe("wait");
  });

  it("TestToolbar_CreatingTrue_PreventsClicks — onClick spies are not called", () => {
    const onNewNote = vi.fn();
    const onNewFolder = vi.fn();
    render(
      <SidebarToolbar
        onNewNote={onNewNote}
        onNewFolder={onNewFolder}
        creating={true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect(onNewNote).not.toHaveBeenCalled();
    expect(onNewFolder).not.toHaveBeenCalled();
  });

  it("TestToolbar_CreatingDefaultsToFalse — omitting prop keeps existing behavior", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "New note" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "New folder" })).not.toBeDisabled();
  });

  // ── D-08 enforcement: global controls are NOT present ──────────────
  it("TestToolbar_DoesNotRenderConnectionStatusDot (D-08)", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("connection-status-dot")).toBeNull();
  });

  it("TestToolbar_DoesNotRenderReindexButton (D-08)", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/Reindex notes/i)).toBeNull();
    expect(screen.queryByLabelText(/Refresh/i)).toBeNull();
  });

  it("TestToolbar_DoesNotRenderSettingsMenu (D-08)", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("settings-menu-trigger")).toBeNull();
  });
});

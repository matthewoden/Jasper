/**
 * SidebarToolbar tests — note-navigation controls: New note, New folder,
 * Sort notes (Phase 29, SORT-01). Today and Search moved to the activity
 * ribbon (Phase 18/19).
 *
 * SidebarToolbar now self-wires NotesSortMenu via useWorkspace(), which
 * calls useToast() — every render() below must be wrapped in <ToastProvider>.
 */
import { fireEvent, render, screen, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn().mockResolvedValue({
      data: {
        appName: "Jasper",
        theme: "dark",
        dailyNotes: { folder: "daily", template: "" },
        editor: { fontSize: 15, lineHeight: 1.6 },
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
import { ToastProvider } from "./Toast";
import { TooltipProvider } from "./Tooltip";

function renderToolbar(
  ui: ReactElement,
  options?: RenderOptions,
): RenderResult {
  return render(ui, {
    wrapper: ({ children }) => (
      <ToastProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </ToastProvider>
    ),
    ...options,
  });
}

describe("<SidebarToolbar /> — note-navigation controls only (Phase 6.6 + Phase 7 + Phase 19)", () => {
  it("TestToolbar_RendersNewNoteButton", () => {
    renderToolbar(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
  });

  it("TestToolbar_RendersNewFolderButton", () => {
    renderToolbar(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "New folder" })).toBeInTheDocument();
  });

  it("TestToolbar_NewNote_OnClick", () => {
    const onNewNote = vi.fn();
    renderToolbar(
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
    renderToolbar(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={onNewFolder}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect(onNewFolder).toHaveBeenCalledTimes(1);
  });

  it("TestToolbar_NoNativeTitle_NewNoteAndNewFolder (D-07: migrated to shared Tooltip)", () => {
    renderToolbar(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "New note" }).getAttribute("title"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "New folder" }).getAttribute("title"),
    ).toBeNull();
  });

  it("TestToolbar_CreatingFalse_ButtonsEnabled — default state", () => {
    renderToolbar(
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
    renderToolbar(
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
    renderToolbar(
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
    renderToolbar(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "New note" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "New folder" })).not.toBeDisabled();
  });

  it("TestToolbar_DoesNotRenderConnectionStatusDot (D-08)", () => {
    renderToolbar(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("connection-status-dot")).toBeNull();
  });

  it("TestToolbar_DoesNotRenderReindexButton (D-08)", () => {
    renderToolbar(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/Reindex notes/i)).toBeNull();
    expect(screen.queryByLabelText(/Refresh/i)).toBeNull();
  });

  it("TestToolbar_DoesNotRenderSettingsMenu (D-08)", () => {
    renderToolbar(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("settings-menu-trigger")).toBeNull();
  });

  it("TestToolbar_DoesNotRenderTodayButton (Phase 19: ribbon owns Today)", () => {
    renderToolbar(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Open today's daily note" }),
    ).toBeNull();
  });

  it("TestToolbar_DoesNotRenderSearchButton (Phase 19: ribbon owns Search)", () => {
    renderToolbar(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Search notes")).toBeNull();
  });

  it("TestToolbar_RendersExactlyThreeButtons — New note + New folder + Sort notes (Phase 29)", () => {
    renderToolbar(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    expect(buttons[0].getAttribute("aria-label")).toBe("New note");
    expect(buttons[1].getAttribute("aria-label")).toBe("New folder");
    expect(buttons[2].getAttribute("aria-label")).toBe("Sort notes");
  });
});

/**
 * SidebarToolbar tests — Phase 6.6 Plan 10 update + Phase 7 Today button (D-16).
 *
 * Global controls (ConnectionStatusDot, Refresh, SettingsMenu) have been
 * stripped per D-08. Note-navigation controls:
 *   1. New note (FilePlus)
 *   2. New folder (FolderPlus)
 *   3. Today (CalendarDays) — Phase 7 D-16
 *
 * useDailyNote is mocked so the tests don't need a ToastProvider or
 * a real network connection. The hook's openToday + isLoading are
 * controlled per test.
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

// Mock useDailyNote so SidebarToolbar can render without ToastProvider.
// Default: openToday is a spy, isLoading is false.
const mockOpenToday = vi.fn();
vi.mock("../lib/useDailyNote", () => ({
  useDailyNote: vi.fn(() => ({
    openToday: mockOpenToday,
    isLoading: false,
  })),
}));

import { useDailyNote } from "../lib/useDailyNote";
const mockedUseDailyNote = vi.mocked(useDailyNote);

import { SidebarToolbar } from "./SidebarToolbar";

describe("<SidebarToolbar /> — note-navigation controls only (Phase 6.6 + Phase 7)", () => {
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

  // ── Phase 7 D-16: Today button (CalendarDays) ──────────────────────
  it("TestToolbar_RendersTodayButton", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    const todayBtn = screen.getByRole("button", { name: "Open today's daily note" });
    expect(todayBtn).toBeInTheDocument();
  });

  it("TestToolbar_TodayButton_HasCorrectTitle", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    const todayBtn = screen.getByRole("button", { name: "Open today's daily note" });
    expect(todayBtn.getAttribute("title")).toBe("Today (⌘⇧D)");
  });

  it("TestToolbar_TodayButton_CallsOpenToday_OnClick", () => {
    const openTodaySpy = vi.fn();
    mockedUseDailyNote.mockReturnValueOnce({ openToday: openTodaySpy, isLoading: false });

    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open today's daily note" }));
    expect(openTodaySpy).toHaveBeenCalledTimes(1);
  });

  it("TestToolbar_TodayButton_ShowsWaitCursor_WhenLoading", () => {
    mockedUseDailyNote.mockReturnValueOnce({ openToday: vi.fn(), isLoading: true });

    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    const todayBtn = screen.getByRole("button", { name: "Open today's daily note" });
    expect(todayBtn).toBeDisabled();
    expect(todayBtn.style.cursor).toBe("wait");
    expect(todayBtn.style.opacity).toBe("0.5");
  });

  it("TestToolbar_TodayButton_IsEnabledByDefault_WhenNotLoading", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    const todayBtn = screen.getByRole("button", { name: "Open today's daily note" });
    expect(todayBtn).not.toBeDisabled();
    expect(todayBtn.style.cursor).toBe("pointer");
    expect(todayBtn.style.opacity).toBe("1");
  });

  it("TestToolbar_TodayButton_IsAfterFolderPlus — third button in cluster", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
      />,
    );
    const buttons = screen.getAllByRole("button");
    // Expect: [New note, New folder, Today]
    expect(buttons).toHaveLength(3);
    expect(buttons[0].getAttribute("aria-label")).toBe("New note");
    expect(buttons[1].getAttribute("aria-label")).toBe("New folder");
    expect(buttons[2].getAttribute("aria-label")).toBe("Open today's daily note");
  });
});

/**
 * SidebarToolbar tests — note-navigation controls: New note, New folder,
 * Today (CalendarDays), and Search icon.
 *
 * useDailyNote is mocked so tests don't need a ToastProvider or network.
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


const mockOpenToday = vi.fn();
vi.mock("../lib/useDailyNote", () => ({
  useDailyNote: vi.fn(() => ({
    openToday: mockOpenToday,
    isLoading: false,
  })),
}));

import { useDailyNote } from "../lib/useDailyNote";
const mockedUseDailyNote = vi.mocked(useDailyNote);

import { useTreeStore } from "../lib/useTreeStore";
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
    expect(buttons).toHaveLength(4);
    expect(buttons[0].getAttribute("aria-label")).toBe("New note");
    expect(buttons[1].getAttribute("aria-label")).toBe("New folder");
    expect(buttons[2].getAttribute("aria-label")).toBe("Open today's daily note");
    expect(buttons[3].getAttribute("aria-label")).toBe("Search notes");
  });

  describe("ST-search — Search icon button (UAT-2 R1-5 + UAT-7)", () => {
    it("ST-S-1: renders a Search button with aria-label 'Search notes'", () => {
      render(<SidebarToolbar onNewNote={vi.fn()} onNewFolder={vi.fn()} />);
      const btn = screen.getByLabelText("Search notes");
      expect(btn).toBeInTheDocument();
    });

    it("SBT-UAT7-1: clicking Search opens palette in search mode (NOT notes)", () => {
      useTreeStore.setState({ paletteOpen: false, paletteMode: "commands" });
      render(<SidebarToolbar onNewNote={vi.fn()} onNewFolder={vi.fn()} />);
      fireEvent.click(screen.getByLabelText("Search notes"));
      const state = useTreeStore.getState();
      expect(state.paletteOpen).toBe(true);
      expect(state.paletteMode).toBe("search");
    });

    it("SBT-UAT7-2: Search button has title tooltip 'Search notes (⌘⇧F)'", () => {
      render(<SidebarToolbar onNewNote={vi.fn()} onNewFolder={vi.fn()} />);
      const btn = screen.getByLabelText("Search notes");
      expect(btn.getAttribute("title")).toBe("Search notes (⌘⇧F)");
    });
  });
});

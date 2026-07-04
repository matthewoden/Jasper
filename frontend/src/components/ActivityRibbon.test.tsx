/**
 * ActivityRibbon tests — nav landmark, vault badge (letter + fallback), and
 * the four wired buttons (Files, Search, daily-note, palette) including
 * their accent-active state.
 *
 * Phase 19 Plan 04 (LSIDE-02): Search/Files toggles are re-derived from the
 * persisted `sidebarPanel` slice (D-07), replacing the old
 * `paletteOpen && paletteMode === "search"` derivation. See D-01/D-02/D-03
 * for the symmetric open/switch-in-place/collapse toggle model.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSetNotesSidebarVisible = vi.fn();
const mockSetPaletteMode = vi.fn();
const mockSetPaletteOpen = vi.fn();
const mockSetSidebarPanel = vi.fn();

let mockNotesSidebarVisible = true;
let mockSidebarPanel: "files" | "search" = "files";

vi.mock("../lib/useTreeStore", () => {
  const state = () => ({
    notesSidebarVisible: mockNotesSidebarVisible,
    setNotesSidebarVisible: mockSetNotesSidebarVisible,
    sidebarPanel: mockSidebarPanel,
    setSidebarPanel: mockSetSidebarPanel,
    setPaletteMode: mockSetPaletteMode,
    setPaletteOpen: mockSetPaletteOpen,
  });
  const useTreeStore = (selector: (s: unknown) => unknown) => selector(state());
  useTreeStore.getState = () => state();
  return { useTreeStore };
});

vi.mock("../lib/appShortcuts", () => ({
  dispatchPhase7: vi.fn(),
}));

const mockOpenToday = vi.fn();
let mockTodayLoading = false;
vi.mock("../lib/useDailyNote", () => ({
  useDailyNote: () => ({
    openToday: mockOpenToday,
    isLoading: mockTodayLoading,
  }),
}));

let mockDisplayName: string | null = "My Vault";
vi.mock("../lib/useVaultPicker", () => ({
  useVaultPicker: () => ({
    isOpen: false,
    open: vi.fn(),
    close: vi.fn(),
    current: mockDisplayName === null ? null : { display_name: mockDisplayName },
    recents: [],
    banner: "",
    isLoading: false,
    refresh: vi.fn(),
  }),
}));

import { ActivityRibbon } from "./ActivityRibbon";
import { mod, shift } from "../lib/shortcutsRegistry";
import { dispatchPhase7 as mockDispatchPhase7 } from "../lib/appShortcuts";

describe("ActivityRibbon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockSidebarPanel = "files";
    mockTodayLoading = false;
    mockDisplayName = "My Vault";
  });

  it("renders the Activity ribbon nav landmark", () => {
    render(<ActivityRibbon />);
    expect(
      screen.getByRole("navigation", { name: "Activity ribbon" }),
    ).toBeInTheDocument();
  });

  it("shows the uppercased first letter of the vault display_name in the badge", () => {
    mockDisplayName = "jasper vault";
    render(<ActivityRibbon />);
    expect(screen.getByLabelText("Vault: jasper vault").textContent).toBe("J");
  });

  it("falls back to 'J' when display_name is empty", () => {
    mockDisplayName = "";
    render(<ActivityRibbon />);
    expect(screen.getByLabelText(/^Vault:/).textContent).toBe("J");
  });

  it("falls back to 'J' when there is no current vault (null)", () => {
    mockDisplayName = null;
    render(<ActivityRibbon />);
    expect(screen.getByLabelText(/^Vault:/).textContent).toBe("J");
  });

  it("shows the whole code point for an emoji-led vault name, not a broken half-surrogate (IN-01)", () => {
    mockDisplayName = "📓 Notes";
    render(<ActivityRibbon />);
    expect(screen.getByLabelText(/^Vault:/).textContent).toBe("📓");
  });

  it("exposes the vault badge to assistive tech via role=img (IN-02)", () => {
    render(<ActivityRibbon />);
    expect(
      screen.getByRole("img", { name: /^Vault:/ }).textContent,
    ).toBe("M");
  });

  it("Files toggle: active when notesSidebarVisible && sidebarPanel==='files' (D-07)", () => {
    mockNotesSidebarVisible = true;
    mockSidebarPanel = "files";
    render(<ActivityRibbon />);
    const btn = screen.getByRole("button", { name: "Files" });
    expect(btn.style.color).toBe("var(--color-accent)");
  });

  it("Files toggle: inactive when notesSidebarVisible is false", () => {
    mockNotesSidebarVisible = false;
    render(<ActivityRibbon />);
    const btn = screen.getByRole("button", { name: "Files" });
    expect(btn.style.color).toBe("var(--color-muted)");
  });

  it("Files toggle: inactive when sidebar visible but panel is 'search' (D-07)", () => {
    mockNotesSidebarVisible = true;
    mockSidebarPanel = "search";
    render(<ActivityRibbon />);
    const btn = screen.getByRole("button", { name: "Files" });
    expect(btn.style.color).toBe("var(--color-muted)");
  });

  it("D-01: Search click with sidebar closed opens it to Search panel + focuses input", () => {
    mockNotesSidebarVisible = false;
    mockSidebarPanel = "files";
    render(<ActivityRibbon />);
    fireEvent.click(screen.getByRole("button", { name: "Search notes" }));
    expect(mockSetSidebarPanel).toHaveBeenCalledWith("search");
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(true);
    expect(mockDispatchPhase7).toHaveBeenCalledWith("focusSearch");
  });

  it("D-02: Search click while Search panel showing collapses the sidebar (honest toggle)", () => {
    mockNotesSidebarVisible = true;
    mockSidebarPanel = "search";
    render(<ActivityRibbon />);
    fireEvent.click(screen.getByRole("button", { name: "Search notes" }));
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(false);
    expect(mockSetSidebarPanel).not.toHaveBeenCalled();
    expect(mockDispatchPhase7).not.toHaveBeenCalled();
  });

  it("D-03: Files click while Search panel showing switches to Files in place (sidebar stays open)", () => {
    mockNotesSidebarVisible = true;
    mockSidebarPanel = "search";
    render(<ActivityRibbon />);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(mockSetSidebarPanel).toHaveBeenCalledWith("files");
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(true);
  });

  it("D-03: Files click while Files panel already active + sidebar open collapses the sidebar", () => {
    mockNotesSidebarVisible = true;
    mockSidebarPanel = "files";
    render(<ActivityRibbon />);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(false);
    expect(mockSetSidebarPanel).not.toHaveBeenCalled();
  });

  it("D-07: Search icon active only when notesSidebarVisible && sidebarPanel==='search'", () => {
    mockNotesSidebarVisible = true;
    mockSidebarPanel = "search";
    render(<ActivityRibbon />);
    const btn = screen.getByRole("button", { name: "Search notes" });
    expect(btn.style.color).toBe("var(--color-accent)");
  });

  it("D-07: Search icon inactive when sidebar visible but panel is 'files'", () => {
    mockNotesSidebarVisible = true;
    mockSidebarPanel = "files";
    render(<ActivityRibbon />);
    const btn = screen.getByRole("button", { name: "Search notes" });
    expect(btn.style.color).toBe("var(--color-muted)");
  });

  it("D-07: Search icon inactive when sidebar is closed even if panel==='search'", () => {
    mockNotesSidebarVisible = false;
    mockSidebarPanel = "search";
    render(<ActivityRibbon />);
    const btn = screen.getByRole("button", { name: "Search notes" });
    expect(btn.style.color).toBe("var(--color-muted)");
  });

  it("Daily button: clicking calls the mocked openToday", () => {
    render(<ActivityRibbon />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open today's daily note" }),
    );
    expect(mockOpenToday).toHaveBeenCalledTimes(1);
  });

  it("Daily button: disabled while isLoading", () => {
    mockTodayLoading = true;
    render(<ActivityRibbon />);
    expect(
      screen.getByRole("button", { name: "Open today's daily note" }),
    ).toBeDisabled();
  });

  it("RibbonButton: hover tint clears when the button becomes disabled mid-hover (IN-01)", () => {
    const { rerender } = render(<ActivityRibbon />);
    const btn = screen.getByRole("button", { name: "Open today's daily note" });

    fireEvent.mouseEnter(btn);
    expect(btn.style.background).toBe(
      "color-mix(in srgb, var(--color-fg) 8%, transparent)",
    );

    mockTodayLoading = true;
    rerender(<ActivityRibbon />);

    expect(btn.style.background).toBe("transparent");
  });

  it("RibbonButton: hover tint stays cleared after a disable/re-enable cycle when the pointer left while disabled (IN-01)", () => {
    const { rerender } = render(<ActivityRibbon />);
    const btn = screen.getByRole("button", { name: "Open today's daily note" });

    fireEvent.mouseEnter(btn);
    mockTodayLoading = true;
    rerender(<ActivityRibbon />);
    // Pointer leaves while disabled: the browser suppresses mouse events on
    // disabled buttons, so no mouseLeave is fired here.
    mockTodayLoading = false;
    rerender(<ActivityRibbon />);

    expect(btn.style.background).toBe("transparent");
  });

  it("tooltips derive the modifier glyphs from the shared shortcuts registry, not hardcoded ⌘ (IN-05)", () => {
    render(<ActivityRibbon />);
    expect(
      screen.getByRole("button", { name: "Search notes" }).title,
    ).toBe(`Search notes (${mod}${shift}F)`);
    expect(
      screen.getByRole("button", { name: "Open today's daily note" }).title,
    ).toBe(`Today (${mod}${shift}D)`);
    expect(
      screen.getByRole("button", { name: "Open command palette" }).title,
    ).toBe(`Command palette (${mod}P)`);
  });

  it("Palette button: clicking calls setPaletteMode('commands') then setPaletteOpen(true)", () => {
    render(<ActivityRibbon />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open command palette" }),
    );
    expect(mockSetPaletteMode).toHaveBeenCalledWith("commands");
    expect(mockSetPaletteOpen).toHaveBeenCalledWith(true);
  });
});

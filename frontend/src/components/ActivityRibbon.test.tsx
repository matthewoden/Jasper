/**
 * ActivityRibbon tests — nav landmark, vault badge (letter + fallback), and
 * the four wired buttons (Files, Search, daily-note, palette) including
 * their accent-active state.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSetNotesSidebarVisible = vi.fn();
const mockSetPaletteMode = vi.fn();
const mockSetPaletteOpen = vi.fn();

let mockNotesSidebarVisible = true;
let mockPaletteOpen = false;
let mockPaletteMode: "notes" | "commands" | "search" = "commands";

vi.mock("../lib/useTreeStore", () => {
  const state = () => ({
    notesSidebarVisible: mockNotesSidebarVisible,
    setNotesSidebarVisible: mockSetNotesSidebarVisible,
    paletteOpen: mockPaletteOpen,
    paletteMode: mockPaletteMode,
    setPaletteMode: mockSetPaletteMode,
    setPaletteOpen: mockSetPaletteOpen,
  });
  const useTreeStore = (selector: (s: unknown) => unknown) => selector(state());
  useTreeStore.getState = () => state();
  return { useTreeStore };
});

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

describe("ActivityRibbon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockPaletteOpen = false;
    mockPaletteMode = "commands";
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

  it("Files toggle: active when notesSidebarVisible is true", () => {
    mockNotesSidebarVisible = true;
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

  it("Files toggle: clicking calls setNotesSidebarVisible with the negated value", () => {
    mockNotesSidebarVisible = true;
    render(<ActivityRibbon />);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(false);
  });

  it("Search toggle: active when paletteOpen && paletteMode === 'search'", () => {
    mockPaletteOpen = true;
    mockPaletteMode = "search";
    render(<ActivityRibbon />);
    const btn = screen.getByRole("button", { name: "Search notes (⌘⇧F)" });
    expect(btn.style.color).toBe("var(--color-accent)");
  });

  it("Search toggle: inactive when paletteMode is not 'search'", () => {
    mockPaletteOpen = true;
    mockPaletteMode = "commands";
    render(<ActivityRibbon />);
    const btn = screen.getByRole("button", { name: "Search notes (⌘⇧F)" });
    expect(btn.style.color).toBe("var(--color-muted)");
  });

  it("Search toggle: clicking calls setPaletteMode('search') then setPaletteOpen(true)", () => {
    render(<ActivityRibbon />);
    fireEvent.click(screen.getByRole("button", { name: "Search notes (⌘⇧F)" }));
    expect(mockSetPaletteMode).toHaveBeenCalledWith("search");
    expect(mockSetPaletteOpen).toHaveBeenCalledWith(true);
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

  it("Palette button: clicking calls setPaletteMode('commands') then setPaletteOpen(true)", () => {
    render(<ActivityRibbon />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open command palette" }),
    );
    expect(mockSetPaletteMode).toHaveBeenCalledWith("commands");
    expect(mockSetPaletteOpen).toHaveBeenCalledWith(true);
  });
});

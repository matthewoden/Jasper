/**
 * ActivityRibbon tests — nav landmark, vault badge (letter + fallback), and
 * the three wired buttons (quick-switcher, daily-note, palette).
 *
 * Phase 27 NAV-02 (D-09/D-10): the Files/Search toggles are gone — panel
 * selection now lives entirely in SidebarTabRow. The ribbon's quick-switcher
 * button opens today's existing unmodified Cmd+O switcher (mode="notes").
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSetPaletteMode = vi.fn();
const mockSetPaletteOpen = vi.fn();

vi.mock("../lib/useTreeStore", () => {
  const state = () => ({
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
import { mod, shift } from "../lib/shortcutsRegistry";

describe("ActivityRibbon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("NAV-02: renders exactly one quick-switcher button, no Files/Search toggles", () => {
    render(<ActivityRibbon />);
    expect(
      screen.getByRole("button", { name: "Quick switcher" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Search notes" })).toBeNull();
  });

  it("D-10: clicking the quick-switcher sets paletteMode('notes') then paletteOpen(true)", () => {
    render(<ActivityRibbon />);
    fireEvent.click(screen.getByRole("button", { name: "Quick switcher" }));
    expect(mockSetPaletteMode).toHaveBeenCalledWith("notes");
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
      screen.getByRole("button", { name: "Quick switcher" }).title,
    ).toBe(`Quick switcher (${mod}O)`);
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

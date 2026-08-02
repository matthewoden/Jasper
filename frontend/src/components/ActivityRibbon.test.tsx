/**
 * ActivityRibbon tests — nav landmark, vault badge (letter + fallback), and
 * the three wired buttons (quick-switcher, daily-note, palette).
 *
 * NAV-02: the Files/Search toggles are gone — panel
 * selection now lives entirely in SidebarTabRow. The ribbon's quick-switcher
 * button opens today's existing unmodified Cmd+O switcher (mode="notes").
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { TooltipProvider } from "./Tooltip";

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

function renderRibbon() {
  return render(
    <TooltipProvider>
      <ActivityRibbon />
    </TooltipProvider>,
  );
}

function rerenderRibbon(rerender: (ui: ReactElement) => void) {
  rerender(
    <TooltipProvider>
      <ActivityRibbon />
    </TooltipProvider>,
  );
}

describe("ActivityRibbon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTodayLoading = false;
    mockDisplayName = "My Vault";
  });

  it("renders the Activity ribbon nav landmark", () => {
    renderRibbon();
    expect(
      screen.getByRole("navigation", { name: "Activity ribbon" }),
    ).toBeInTheDocument();
  });

  it("shows the uppercased first letter of the vault display_name in the badge", () => {
    mockDisplayName = "jasper vault";
    renderRibbon();
    expect(screen.getByLabelText("Vault: jasper vault").textContent).toBe("J");
  });

  it("falls back to 'J' when display_name is empty", () => {
    mockDisplayName = "";
    renderRibbon();
    expect(screen.getByLabelText(/^Vault:/).textContent).toBe("J");
  });

  it("falls back to 'J' when there is no current vault (null)", () => {
    mockDisplayName = null;
    renderRibbon();
    expect(screen.getByLabelText(/^Vault:/).textContent).toBe("J");
  });

  it("shows the whole code point for an emoji-led vault name, not a broken half-surrogate", () => {
    mockDisplayName = "📓 Notes";
    renderRibbon();
    expect(screen.getByLabelText(/^Vault:/).textContent).toBe("📓");
  });

  it("exposes the vault badge to assistive tech via role=img", () => {
    renderRibbon();
    expect(
      screen.getByRole("img", { name: /^Vault:/ }).textContent,
    ).toBe("M");
  });

  it("NAV-02: renders exactly one quick-switcher button, no Files/Search toggles", () => {
    renderRibbon();
    expect(
      screen.getByRole("button", { name: "Quick switcher" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Search notes" })).toBeNull();
  });

  it("quick-switcher icon is distinct from the sidebar Search tab's Search glyph", () => {
    renderRibbon();
    const btn = screen.getByRole("button", { name: "Quick switcher" });
    const svg = btn.querySelector("svg");
    expect(svg).not.toBeNull();
    // SidebarTabRow's Search tab renders lucide-react's <Search> (class "lucide-search").
    // The ribbon's quick switcher must NOT share that exact glyph.
    expect(svg?.classList.contains("lucide-search")).toBe(false);
  });

  it("clicking the quick-switcher sets paletteMode('notes') then paletteOpen(true)", () => {
    renderRibbon();
    fireEvent.click(screen.getByRole("button", { name: "Quick switcher" }));
    expect(mockSetPaletteMode).toHaveBeenCalledWith("notes");
    expect(mockSetPaletteOpen).toHaveBeenCalledWith(true);
  });

  it("Daily button: clicking calls the mocked openToday", () => {
    renderRibbon();
    fireEvent.click(
      screen.getByRole("button", { name: "Open today's daily note" }),
    );
    expect(mockOpenToday).toHaveBeenCalledTimes(1);
  });

  it("Daily button: disabled while isLoading", () => {
    mockTodayLoading = true;
    renderRibbon();
    expect(
      screen.getByRole("button", { name: "Open today's daily note" }),
    ).toBeDisabled();
  });

  it("mock parity: renders the command palette and a bottom Settings gear", () => {
    renderRibbon();
    expect(
      screen.getByRole("button", { name: "Open command palette" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Settings" }),
    ).toBeInTheDocument();
  });

  it("command palette button sets paletteMode('commands') then paletteOpen(true)", () => {
    renderRibbon();
    fireEvent.click(
      screen.getByRole("button", { name: "Open command palette" }),
    );
    expect(mockSetPaletteMode).toHaveBeenCalledWith("commands");
    expect(mockSetPaletteOpen).toHaveBeenCalledWith(true);
  });

  it("RibbonButton: hover tint clears when the button becomes disabled mid-hover", () => {
    const { rerender } = renderRibbon();
    const btn = screen.getByRole("button", { name: "Open today's daily note" });

    fireEvent.mouseEnter(btn);
    expect(btn.style.background).toBe(
      "color-mix(in srgb, var(--color-fg) 8%, transparent)",
    );

    mockTodayLoading = true;
    rerenderRibbon(rerender);

    expect(btn.style.background).toBe("transparent");
  });

  it("RibbonButton: hover tint stays cleared after a disable/re-enable cycle when the pointer left while disabled", () => {
    const { rerender } = renderRibbon();
    const btn = screen.getByRole("button", { name: "Open today's daily note" });

    fireEvent.mouseEnter(btn);
    mockTodayLoading = true;
    rerenderRibbon(rerender);
    // Pointer leaves while disabled: the browser suppresses mouse events on
    // disabled buttons, so no mouseLeave is fired here.
    mockTodayLoading = false;
    rerenderRibbon(rerender);

    expect(btn.style.background).toBe("transparent");
  });

  it("ribbon buttons have no native title (Tooltip-migrated), aria-labels preserved", () => {
    renderRibbon();
    for (const name of [
      "Quick switcher",
      "Open today's daily note",
      "Open command palette",
      "Settings",
    ]) {
      const btn = screen.getByRole("button", { name });
      expect(btn).not.toHaveAttribute("title");
    }
  });

  it("tooltips derive the modifier glyphs from the shared shortcuts registry, not hardcoded ⌘", () => {
    renderRibbon();
    fireEvent.focus(screen.getByRole("button", { name: "Quick switcher" }));
    expect(screen.getByText("Quick switcher")).toBeInTheDocument();
    expect(screen.getByText(`${mod}O`)).toBeInTheDocument();

    fireEvent.focus(
      screen.getByRole("button", { name: "Open today's daily note" }),
    );
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText(`${mod}${shift}D`)).toBeInTheDocument();

    fireEvent.focus(
      screen.getByRole("button", { name: "Open command palette" }),
    );
    expect(screen.getByText("Command palette")).toBeInTheDocument();
    expect(screen.getByText(`${mod}P`)).toBeInTheDocument();
  });

  it("Palette button: clicking calls setPaletteMode('commands') then setPaletteOpen(true)", () => {
    renderRibbon();
    fireEvent.click(
      screen.getByRole("button", { name: "Open command palette" }),
    );
    expect(mockSetPaletteMode).toHaveBeenCalledWith("commands");
    expect(mockSetPaletteOpen).toHaveBeenCalledWith(true);
  });
});

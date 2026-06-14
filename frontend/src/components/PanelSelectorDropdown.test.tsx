/**
 * PanelSelectorDropdown tests — action-menu model (each item opens its panel).
 *
 * Covers: trigger aria-label; dropdown renders Tags + Backlinks menuitems;
 * items are plain menuitems (no aria-checked); clicking calls setPanelSelector;
 * collapsed rail is expanded on panel open; zIndex: 100 on content.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockSetPanelSelector = vi.fn();
const mockSetBacklinksRailExpanded = vi.fn();
let mockBacklinksRailExpanded = true;

vi.mock("../lib/useTreeStore", () => {
  const buildStore = () => ({
    panelSelector: { tags: false, backlinks: false },
    setPanelSelector: mockSetPanelSelector,
    backlinksRailExpanded: mockBacklinksRailExpanded,
    setBacklinksRailExpanded: mockSetBacklinksRailExpanded,
  });
  const useTreeStore = (selector?: (s: unknown) => unknown) => {
    const store = buildStore();
    return selector ? selector(store) : store;
  };
  (useTreeStore as unknown as { getState: () => unknown }).getState = buildStore;
  return { useTreeStore };
});

import { PanelSelectorDropdown } from "./PanelSelectorDropdown";

beforeEach(() => {
  vi.clearAllMocks();
  mockBacklinksRailExpanded = true;
});

describe("<PanelSelectorDropdown />", () => {
  it("Test 1: renders a trigger button with aria-label='Open panel'", () => {
    render(<PanelSelectorDropdown />);
    const btn = screen.getByRole("button", { name: /open panel/i });
    expect(btn).toBeDefined();
    expect(btn.getAttribute("aria-label")).toBe("Open panel");
    expect(btn.getAttribute("title")).toBe("Open panel");
  });

  it("Test 2: clicking the trigger opens the dropdown — Content portal renders into DOM", async () => {
    const user = userEvent.setup();
    render(<PanelSelectorDropdown />);
    await user.click(screen.getByRole("button", { name: /open panel/i }));
    await waitFor(() => {
      const items = screen.getAllByRole("menuitem");
      expect(items.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("Test 3: Content contains two menuitem entries labeled 'Tags' and 'Backlinks'", async () => {
    const user = userEvent.setup();
    render(<PanelSelectorDropdown />);
    await user.click(screen.getByRole("button", { name: /open panel/i }));
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: /tags/i })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: /backlinks/i })).toBeDefined();
    });
  });

  it("Test 4: items render as plain menuitems with no aria-checked indicator", async () => {
    const user = userEvent.setup();
    render(<PanelSelectorDropdown />);
    await user.click(screen.getByRole("button", { name: /open panel/i }));
    await waitFor(() => {
      const tagsItem = screen.getByRole("menuitem", { name: /tags/i });
      expect(tagsItem.getAttribute("aria-checked")).toBeNull();
      expect(screen.queryAllByRole("menuitemcheckbox").length).toBe(0);
    });
  });

  it("Test 5: clicking Tags calls setPanelSelector({ tags: true })", async () => {
    const user = userEvent.setup();
    render(<PanelSelectorDropdown />);
    await user.click(screen.getByRole("button", { name: /open panel/i }));
    await waitFor(() => screen.getByRole("menuitem", { name: /tags/i }));
    await user.click(screen.getByRole("menuitem", { name: /tags/i }));
    expect(mockSetPanelSelector).toHaveBeenCalledWith({ tags: true });
  });

  it("Test 6: clicking Backlinks calls setPanelSelector({ backlinks: true })", async () => {
    const user = userEvent.setup();
    render(<PanelSelectorDropdown />);
    await user.click(screen.getByRole("button", { name: /open panel/i }));
    await waitFor(() => screen.getByRole("menuitem", { name: /backlinks/i }));
    await user.click(screen.getByRole("menuitem", { name: /backlinks/i }));
    expect(mockSetPanelSelector).toHaveBeenCalledWith({ backlinks: true });
  });

  it("Test 7: opening a panel while the rail is collapsed also expands the rail", async () => {
    mockBacklinksRailExpanded = false;
    const user = userEvent.setup();
    render(<PanelSelectorDropdown />);
    await user.click(screen.getByRole("button", { name: /open panel/i }));
    await waitFor(() => screen.getByRole("menuitem", { name: /tags/i }));
    await user.click(screen.getByRole("menuitem", { name: /tags/i }));
    expect(mockSetPanelSelector).toHaveBeenCalledWith({ tags: true });
    expect(mockSetBacklinksRailExpanded).toHaveBeenCalledWith(true);
  });

  it("Test 8: Content element carries inline zIndex: 100 style", async () => {
    const user = userEvent.setup();
    render(<PanelSelectorDropdown />);
    await user.click(screen.getByRole("button", { name: /open panel/i }));
    await waitFor(() => screen.getByRole("menuitem", { name: /tags/i }));
    const menu = screen.getByRole("menu");
    const styleAttr = menu.getAttribute("style") ?? "";
    expect(styleAttr).toContain("z-index: 100");
  });
});

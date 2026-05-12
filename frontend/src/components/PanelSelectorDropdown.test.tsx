/**
 * PanelSelectorDropdown.test.tsx — Phase 6.6, Plan 08.
 * TDD RED → GREEN for UX-CHROME-01 (D-03 / D-34).
 *
 * Tests verify:
 *   1. Trigger button renders with aria-label="Select panels"
 *   2. Clicking trigger opens the dropdown Content portal
 *   3. Content contains Tags and Backlinks menuitemcheckbox items
 *   4. When panelSelector.tags === true, Tags item has aria-checked="true"
 *   5. Clicking Tags (checked=true) calls setPanelSelector({ tags: false })
 *   6. Clicking Backlinks (checked=false) calls setPanelSelector({ backlinks: true })
 *   7. Tags and Backlinks toggle independently (no mutual exclusion)
 *   8. Content has zIndex: 100
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock useTreeStore so tests can control panelSelector state
const mockSetPanelSelector = vi.fn();
let mockPanelSelector = { tags: true, backlinks: true };

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: (selector: (s: unknown) => unknown) => {
    const fakeStore = {
      panelSelector: mockPanelSelector,
      setPanelSelector: mockSetPanelSelector,
    };
    return selector(fakeStore);
  },
}));

// Import AFTER mocking
import { PanelSelectorDropdown } from "./PanelSelectorDropdown";

beforeEach(() => {
  vi.clearAllMocks();
  mockPanelSelector = { tags: true, backlinks: true };
});

describe("<PanelSelectorDropdown />", () => {
  it("Test 1: renders a trigger button with aria-label='Select panels'", () => {
    render(<PanelSelectorDropdown />);
    const btn = screen.getByRole("button", { name: /select panels/i });
    expect(btn).toBeDefined();
    expect(btn.getAttribute("aria-label")).toBe("Select panels");
    expect(btn.getAttribute("title")).toBe("Select panels");
  });

  it("Test 2: clicking the trigger opens the dropdown — Content portal renders into DOM", async () => {
    const user = userEvent.setup();
    render(<PanelSelectorDropdown />);
    const trigger = screen.getByRole("button", { name: /select panels/i });
    await user.click(trigger);
    // Radix DropdownMenu.Content renders in a portal on the document body
    await waitFor(() => {
      const items = screen.getAllByRole("menuitemcheckbox");
      expect(items.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("Test 3: Content contains two menuitemcheckbox items labeled 'Tags' and 'Backlinks'", async () => {
    const user = userEvent.setup();
    render(<PanelSelectorDropdown />);
    await user.click(screen.getByRole("button", { name: /select panels/i }));
    await waitFor(() => {
      const tagsItem = screen.getByRole("menuitemcheckbox", { name: /tags/i });
      const backlinksItem = screen.getByRole("menuitemcheckbox", { name: /backlinks/i });
      expect(tagsItem).toBeDefined();
      expect(backlinksItem).toBeDefined();
    });
  });

  it("Test 4: when panelSelector.tags === true, the Tags item has aria-checked='true'", async () => {
    mockPanelSelector = { tags: true, backlinks: false };
    const user = userEvent.setup();
    render(<PanelSelectorDropdown />);
    await user.click(screen.getByRole("button", { name: /select panels/i }));
    await waitFor(() => {
      const tagsItem = screen.getByRole("menuitemcheckbox", { name: /tags/i });
      expect(tagsItem.getAttribute("aria-checked")).toBe("true");
      const backlinksItem = screen.getByRole("menuitemcheckbox", { name: /backlinks/i });
      expect(backlinksItem.getAttribute("aria-checked")).toBe("false");
    });
  });

  it("Test 5: clicking Tags item when checked=true calls setPanelSelector({ tags: false })", async () => {
    mockPanelSelector = { tags: true, backlinks: true };
    const user = userEvent.setup();
    render(<PanelSelectorDropdown />);
    await user.click(screen.getByRole("button", { name: /select panels/i }));
    await waitFor(() => screen.getByRole("menuitemcheckbox", { name: /tags/i }));
    const tagsItem = screen.getByRole("menuitemcheckbox", { name: /tags/i });
    await user.click(tagsItem);
    expect(mockSetPanelSelector).toHaveBeenCalledWith({ tags: false });
  });

  it("Test 6: clicking Backlinks item when checked=false calls setPanelSelector({ backlinks: true })", async () => {
    mockPanelSelector = { tags: true, backlinks: false };
    const user = userEvent.setup();
    render(<PanelSelectorDropdown />);
    await user.click(screen.getByRole("button", { name: /select panels/i }));
    await waitFor(() => screen.getByRole("menuitemcheckbox", { name: /backlinks/i }));
    const backlinksItem = screen.getByRole("menuitemcheckbox", { name: /backlinks/i });
    await user.click(backlinksItem);
    expect(mockSetPanelSelector).toHaveBeenCalledWith({ backlinks: true });
  });

  it("Test 7: Tags and Backlinks toggle independently (no mutual exclusion)", async () => {
    // Both start true — clicking one should NOT affect the other
    mockPanelSelector = { tags: true, backlinks: true };
    const user = userEvent.setup();
    render(<PanelSelectorDropdown />);
    await user.click(screen.getByRole("button", { name: /select panels/i }));
    await waitFor(() => screen.getByRole("menuitemcheckbox", { name: /tags/i }));

    // Click Tags
    const tagsItem = screen.getByRole("menuitemcheckbox", { name: /tags/i });
    await user.click(tagsItem);
    expect(mockSetPanelSelector).toHaveBeenCalledWith({ tags: false });

    // Backlinks was NOT toggled — setPanelSelector should only have been called once
    // (with tags:false only, not affecting backlinks)
    const backlinksCall = mockSetPanelSelector.mock.calls.find(
      (c) => "backlinks" in c[0],
    );
    expect(backlinksCall).toBeUndefined();
  });

  it("Test 8: Content element carries inline zIndex: 100 style", async () => {
    const user = userEvent.setup();
    render(<PanelSelectorDropdown />);
    await user.click(screen.getByRole("button", { name: /select panels/i }));
    await waitFor(() => screen.getByRole("menuitemcheckbox", { name: /tags/i }));

    // Radix DropdownMenu.Content renders with a data-radix-popper-content-wrapper
    // or we can look for the content element directly via role="menu"
    const menu = screen.getByRole("menu");
    // The inline style is on the Content element; Radix wraps in a portal div but
    // the style prop is applied to the Content's own DOM node.
    const styleAttr = menu.getAttribute("style") ?? "";
    // The menu may not have the zIndex directly due to Radix portal wrapper;
    // check the closest wrapper that carries our popoverStyle
    // Radix injects the style directly on the content element (role="menu")
    expect(styleAttr).toContain("z-index: 100");
  });
});

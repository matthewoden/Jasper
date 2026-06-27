/**
 * TabContextMenu tests (TAB-06):
 *   - exactly 4 menu items with the spec labels, in order
 *   - a separator renders after item 1
 *   - selecting each item fires its corresponding callback
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabContextMenu } from "./TabContextMenu";

function renderMenu(overrides?: {
  onOpenRight?: () => void;
  onClose?: () => void;
  onCloseOthers?: () => void;
  onCloseToRight?: () => void;
}) {
  const props = {
    onOpenRight: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToRight: vi.fn(),
    ...overrides,
  };
  render(
    <TabContextMenu {...props}>
      <div data-testid="trigger">note.md</div>
    </TabContextMenu>,
  );
  return props;
}

async function openMenu() {
  fireEvent.contextMenu(screen.getByTestId("trigger"));
  await waitFor(() => {
    expect(screen.getAllByRole("menuitem").length).toBeGreaterThanOrEqual(4);
  });
}

describe("<TabContextMenu />", () => {
  it("TAB-06: renders exactly 4 menu items with the spec labels in order", async () => {
    renderMenu();
    await openMenu();
    const items = screen.getAllByRole("menuitem");
    expect(items.length).toBe(4);
    expect(items.map((i) => i.textContent)).toEqual([
      "New note to the right",
      "Close tab",
      "Close other tabs",
      "Close tabs to the right",
    ]);
  });

  it("TAB-06: renders a separator after item 1", async () => {
    renderMenu();
    await openMenu();
    const separators = screen.getAllByRole("separator");
    expect(separators.length).toBe(1);
    // Separator sits between item 1 (New note to the right) and item 2 (Close tab).
    const menu = screen.getByRole("menu");
    const children = Array.from(menu.children);
    const firstItemIdx = children.findIndex(
      (c) => c.textContent === "New note to the right",
    );
    const sepIdx = children.findIndex((c) => c.getAttribute("role") === "separator");
    const closeIdx = children.findIndex((c) => c.textContent === "Close tab");
    expect(firstItemIdx).toBeLessThan(sepIdx);
    expect(sepIdx).toBeLessThan(closeIdx);
  });

  it("selecting 'New note to the right' fires onOpenRight", async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await openMenu();
    await user.click(
      screen.getByRole("menuitem", { name: "New note to the right" }),
    );
    expect(props.onOpenRight).toHaveBeenCalledTimes(1);
  });

  it("selecting 'Close tab' fires onClose", async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Close tab" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("selecting 'Close other tabs' fires onCloseOthers", async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Close other tabs" }));
    expect(props.onCloseOthers).toHaveBeenCalledTimes(1);
  });

  it("selecting 'Close tabs to the right' fires onCloseToRight", async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await openMenu();
    await user.click(
      screen.getByRole("menuitem", { name: "Close tabs to the right" }),
    );
    expect(props.onCloseToRight).toHaveBeenCalledTimes(1);
  });
});

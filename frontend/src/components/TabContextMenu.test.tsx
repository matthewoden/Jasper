/**
 * TabContextMenu tests (CTX-01, D-11/D-12 — Phase 30 Plan 06):
 *   - all 9 menu items render in the locked UI-SPEC §3 order, with 3 separators
 *   - the Pin/Unpin item label toggles on `isPinned`
 *   - selecting each item fires its corresponding callback
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabContextMenu, type TabContextMenuProps } from "./TabContextMenu";

const LOCKED_ORDER = [
  "Close",
  "Close others",
  "Close to the right",
  "Close all",
  "Open in split",
  "New note to the right",
  "Pin tab",
  "Rename",
  "Show in file manager",
];

function renderMenu(overrides?: Partial<Omit<TabContextMenuProps, "children">>) {
  const props: Omit<TabContextMenuProps, "children"> = {
    onOpenRight: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToRight: vi.fn(),
    onCloseAll: vi.fn(),
    onOpenSplit: vi.fn(),
    isPinned: false,
    onTogglePin: vi.fn(),
    onRename: vi.fn(),
    onReveal: vi.fn(),
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
    expect(screen.getAllByRole("menuitem").length).toBeGreaterThanOrEqual(9);
  });
}

describe("<TabContextMenu />", () => {
  it("CTX-01: renders all 9 items in the locked UI-SPEC order", async () => {
    renderMenu();
    await openMenu();
    const items = screen.getAllByRole("menuitem");
    expect(items.length).toBe(9);
    expect(items.map((i) => i.textContent)).toEqual(LOCKED_ORDER);
  });

  it("CTX-01: renders 3 separators at the locked grouping boundaries", async () => {
    renderMenu();
    await openMenu();
    const separators = screen.getAllByRole("separator");
    expect(separators.length).toBe(3);
    const menu = screen.getByRole("menu");
    const children = Array.from(menu.children);
    const idxOf = (text: string) =>
      children.findIndex((c) => c.textContent === text);
    const sepIdxs = children
      .map((c, i) => (c.getAttribute("role") === "separator" ? i : -1))
      .filter((i) => i !== -1);
    // sep 1: after "Close all", before "Open in split"
    expect(idxOf("Close all")).toBeLessThan(sepIdxs[0]);
    expect(sepIdxs[0]).toBeLessThan(idxOf("Open in split"));
    // sep 2: after "New note to the right", before "Pin tab"
    expect(idxOf("New note to the right")).toBeLessThan(sepIdxs[1]);
    expect(sepIdxs[1]).toBeLessThan(idxOf("Pin tab"));
    // sep 3: after "Pin tab", before "Rename"
    expect(idxOf("Pin tab")).toBeLessThan(sepIdxs[2]);
    expect(sepIdxs[2]).toBeLessThan(idxOf("Rename"));
  });

  it("CTX-01/D-14: shows 'Unpin tab' when isPinned is true", async () => {
    renderMenu({ isPinned: true });
    await openMenu();
    expect(
      screen.getByRole("menuitem", { name: "Unpin tab" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Pin tab" }),
    ).not.toBeInTheDocument();
  });

  it("selecting 'Close' fires onClose", async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("selecting 'Close others' fires onCloseOthers", async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Close others" }));
    expect(props.onCloseOthers).toHaveBeenCalledTimes(1);
  });

  it("selecting 'Close to the right' fires onCloseToRight", async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await openMenu();
    await user.click(
      screen.getByRole("menuitem", { name: "Close to the right" }),
    );
    expect(props.onCloseToRight).toHaveBeenCalledTimes(1);
  });

  it("selecting 'Close all' fires onCloseAll", async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Close all" }));
    expect(props.onCloseAll).toHaveBeenCalledTimes(1);
  });

  it("selecting 'Open in split' fires onOpenSplit", async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Open in split" }));
    expect(props.onOpenSplit).toHaveBeenCalledTimes(1);
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

  it("selecting 'Pin tab' fires onTogglePin", async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Pin tab" }));
    expect(props.onTogglePin).toHaveBeenCalledTimes(1);
  });

  it("selecting 'Unpin tab' fires onTogglePin", async () => {
    const user = userEvent.setup();
    const props = renderMenu({ isPinned: true });
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Unpin tab" }));
    expect(props.onTogglePin).toHaveBeenCalledTimes(1);
  });

  it("selecting 'Rename' fires onRename", async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(props.onRename).toHaveBeenCalledTimes(1);
  });

  it("selecting 'Show in file manager' fires onReveal", async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await openMenu();
    await user.click(
      screen.getByRole("menuitem", { name: "Show in file manager" }),
    );
    expect(props.onReveal).toHaveBeenCalledTimes(1);
  });
});

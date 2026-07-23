/**
 * NotesSortMenu tests — UI-SPEC §Surface 2 / D-02.
 *
 * Uses the controlled `open` prop (mirrors TreeRowMenu.test.tsx's pattern
 * for TreeRowDropdownMenu) to force the Radix portal content to mount
 * without simulating a real pointer click.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { NotesSortMenu } from "./NotesSortMenu";
import { TooltipProvider } from "./Tooltip";
import type { NotesSortOrder } from "../lib/useTreeStore";

function renderMenu(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const ALL_ORDERS: NotesSortOrder[] = [
  "name-asc",
  "name-desc",
  "modified-desc",
  "modified-asc",
  "created-desc",
  "created-asc",
];

const LABELS: Record<NotesSortOrder, string> = {
  "name-asc": "Name (A → Z)",
  "name-desc": "Name (Z → A)",
  "modified-desc": "Modified (new → old)",
  "modified-asc": "Modified (old → new)",
  "created-desc": "Created (new → old)",
  "created-asc": "Created (old → new)",
};

describe("<NotesSortMenu /> — item rendering", () => {
  it("TestSortMenu_RendersSixLabeledItems", () => {
    renderMenu(
      <NotesSortMenu value="name-asc" onSelect={vi.fn()} open={true} />,
    );
    for (const order of ALL_ORDERS) {
      expect(screen.getByText(LABELS[order])).toBeInTheDocument();
    }
  });

  it("TestSortMenu_ActiveOrderShowsCheckmark", () => {
    const { container } = renderMenu(
      <NotesSortMenu value="modified-desc" onSelect={vi.fn()} open={true} />,
    );
    const activeItem = screen
      .getByText(LABELS["modified-desc"])
      .closest('[role="menuitem"]');
    expect(activeItem?.querySelector("svg")).not.toBeNull();

    // No other item should render a checkmark svg.
    for (const order of ALL_ORDERS) {
      if (order === "modified-desc") continue;
      const item = screen.getByText(LABELS[order]).closest('[role="menuitem"]');
      expect(item?.querySelector("svg")).toBeNull();
    }
    expect(container).toBeTruthy();
  });

  it("TestSortMenu_OnSelectFiresWithCorrectOrder", () => {
    const onSelect = vi.fn();
    renderMenu(<NotesSortMenu value="name-asc" onSelect={onSelect} open={true} />);

    fireEvent.click(screen.getByText(LABELS["created-asc"]));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("created-asc");
  });

  it("TestSortMenu_TriggerHasSortNotesLabel", () => {
    renderMenu(<NotesSortMenu value="name-asc" onSelect={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Sort notes", hidden: true }),
    ).toBeInTheDocument();
  });

  it("TestSortMenu_TriggerIsAccentColoredWhileOpen", () => {
    renderMenu(<NotesSortMenu value="name-asc" onSelect={vi.fn()} open={true} />);
    // Radix wraps the rest of the tree (including the trigger) in
    // aria-hidden while the menu is open (focus-scope hide-others), so
    // `hidden: true` is required to still find it by role here.
    const trigger = screen.getByRole("button", {
      name: "Sort notes",
      hidden: true,
    });
    expect(trigger.style.color).toBe("var(--color-accent)");
  });

  it("TestSortMenu_TriggerIsMutedColoredWhileClosed", () => {
    renderMenu(<NotesSortMenu value="name-asc" onSelect={vi.fn()} open={false} />);
    const trigger = screen.getByRole("button", { name: "Sort notes" });
    expect(trigger.style.color).toBe("var(--color-muted)");
  });
});

describe("<NotesSortMenu /> — constant trigger glyph (D-16 reversed by UAT)", () => {
  /**
   * D-16 (order-reflecting six-glyph trigger) was reversed by owner UAT
   * gap-closure: a changing icon read as confusing; consistency was
   * preferred. The trigger renders one constant glyph (`ArrowUpDown`)
   * regardless of the selected order.
   */
  const CONSTANT_GLYPH_CLASS = "lucide-arrow-up-down";

  it("renders the same constant glyph across every NotesSortOrder", () => {
    for (const order of ALL_ORDERS) {
      const { unmount } = renderMenu(
        <NotesSortMenu value={order} onSelect={vi.fn()} />,
      );
      const trigger = screen.getByRole("button", { name: "Sort notes" });
      expect(trigger.querySelector("svg")).toHaveClass(CONSTANT_GLYPH_CLASS);
      unmount();
    }
  });
});

/**
 * TabPill tests:
 *   TAB-04 — close (X) button is always present and never display:none / visibility:hidden,
 *            even when the title is long and truncated.
 *   TAB-05 — middle-click on the pill closes; X click closes without selecting (stopPropagation).
 *   TAB-12 — isDeleted renders "(deleted)" in destructive color.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabPill } from "./TabPill";

describe("<TabPill />", () => {
  it("TAB-04: renders an always-visible close button even with a long truncated title", () => {
    const longTitle =
      "an-extremely-long-note-filename-that-will-truncate-with-ellipsis.md";
    render(
      <TabPill
        title={longTitle}
        isActive={false}
        isDeleted={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const closeBtn = screen.getByRole("button", {
      name: `Close ${longTitle}`,
    });
    expect(closeBtn).toBeDefined();
    const style = closeBtn.getAttribute("style") ?? "";
    expect(style).not.toContain("display: none");
    expect(style).not.toContain("visibility: hidden");
  });

  it("TAB-05: middle-click (button=1) on the pill calls onClose", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
      <TabPill
        title="note.md"
        isActive={false}
        isDeleted={false}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    const pill = screen.getByRole("tab");
    fireEvent(
      pill,
      new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("TAB-05: clicking the X calls onClose and does NOT call onSelect (stopPropagation)", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
      <TabPill
        title="note.md"
        isActive={false}
        isDeleted={false}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close note.md" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clicking the pill body calls onSelect", () => {
    const onSelect = vi.fn();
    render(
      <TabPill
        title="note.md"
        isActive={false}
        isDeleted={false}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("TAB-12: isDeleted renders '(deleted)' in destructive color", () => {
    render(
      <TabPill
        title="note.md"
        isActive={false}
        isDeleted={true}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const label = screen.getByText("(deleted)");
    expect(label).toBeDefined();
    expect(label.getAttribute("style") ?? "").toContain(
      "var(--color-destructive)",
    );
    // The note title is not shown when deleted; the pill carries the read-only aria-label.
    expect(screen.queryByText("note.md")).toBeNull();
    expect(screen.getByRole("tab").getAttribute("aria-label")).toBe(
      "note.md (deleted, read-only)",
    );
  });
});

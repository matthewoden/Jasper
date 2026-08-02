/**
 * The close (X) must never be display:none or visibility:hidden, even when a long
 * title truncates — that was the regression.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabPill } from "./TabPill";
import { TooltipProvider } from "./Tooltip";
import { MIN_TAB_WIDTH, MAX_TAB_WIDTH } from "../lib/tabOverflow";

describe("<TabPill />", () => {
  it("never renders a FileText note icon", () => {
    render(
      <TabPill
        title="note.md"
        isActive={false}
        isDeleted={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // lucide-react renders each icon as an <svg class="lucide lucide-{kebab-name}">.
    expect(document.querySelector("svg.lucide-file-text")).toBeNull();
  });

  it("TAB-16: pill shrinks (flexShrink:1, no flexGrow) between MIN and MAX width", () => {
    render(
      <TabPill
        title="note.md"
        isActive={false}
        isDeleted={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const pill = screen.getByRole("tab");
    expect(pill.style.flexShrink).toBe("1");
    // flexGrow must NOT make pills stretch to fill — left-aligned Obsidian feel.
    expect(pill.style.flexGrow === "" || pill.style.flexGrow === "0").toBe(true);
    expect(pill.style.minWidth).toBe(`${MIN_TAB_WIDTH}px`);
    expect(pill.style.maxWidth).toBe(`${MAX_TAB_WIDTH}px`);
  });

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

  it("native DnD removed: pill does not have draggable attribute", () => {
    render(
      <TabPill
        title="note.md"
        isActive={false}
        isDeleted={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const pill = screen.getByRole("tab");
    // draggable should be absent or explicitly false — never "true".
    expect(pill.getAttribute("draggable")).not.toBe("true");
  });

  it("isDragging=true dims the pill to ~0.4 opacity", () => {
    render(
      <TabPill
        title="note.md"
        isActive={false}
        isDeleted={false}
        isDragging={true}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const pill = screen.getByRole("tab");
    expect(pill.style.opacity).toBe("0.4");
  });

  it("isDragging=false / omitted renders at full opacity (no dimming)", () => {
    render(
      <TabPill
        title="note.md"
        isActive={false}
        isDeleted={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const pill = screen.getByRole("tab");
    const opacity = pill.style.opacity;
    expect(opacity === "" || opacity === "1").toBe(true);
  });

  it("isDragging prop is NOT forwarded to the DOM as an attribute", () => {
    render(
      <TabPill
        title="note.md"
        isActive={false}
        isDeleted={false}
        isDragging={true}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const pill = screen.getByRole("tab");
    expect(pill.hasAttribute("isDragging")).toBe(false);
    expect(pill.hasAttribute("isdragging")).toBe(false);
  });

  it("isPinned renders the Pin glyph in place of the close-× button", () => {
    const onClose = vi.fn();
    render(
      <TooltipProvider>
        <TabPill
          title="note.md"
          isActive={false}
          isDeleted={false}
          isPinned={true}
          onSelect={vi.fn()}
          onClose={onClose}
          onPinnedClickRefused={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByRole("button", { name: "Close note.md" })).toBeNull();
    const pinBtn = screen.getByRole("button", {
      name: "Pinned tab — right-click to unpin",
    });
    expect(pinBtn).toBeInTheDocument();
  });

  it("isPinned=false (default) still renders the close-× button (no regression)", () => {
    render(
      <TabPill
        title="note.md"
        isActive={false}
        isDeleted={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Pinned tab — right-click to unpin" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Close note.md" })).toBeInTheDocument();
  });

  it("clicking the pin glyph calls onPinnedClickRefused, NOT onClose, and does not select the tab", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const onPinnedClickRefused = vi.fn();
    render(
      <TooltipProvider>
        <TabPill
          title="note.md"
          isActive={false}
          isDeleted={false}
          isPinned={true}
          onSelect={onSelect}
          onClose={onClose}
          onPinnedClickRefused={onPinnedClickRefused}
        />
      </TooltipProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Pinned tab — right-click to unpin" }),
    );
    expect(onPinnedClickRefused).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("middle-click on a PINNED pill calls onPinnedClickRefused, NOT onClose", () => {
    const onClose = vi.fn();
    const onPinnedClickRefused = vi.fn();
    render(
      <TooltipProvider>
        <TabPill
          title="note.md"
          isActive={false}
          isDeleted={false}
          isPinned={true}
          onSelect={vi.fn()}
          onClose={onClose}
          onPinnedClickRefused={onPinnedClickRefused}
        />
      </TooltipProvider>,
    );
    const pill = screen.getByRole("tab");
    fireEvent(
      pill,
      new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
    );
    expect(onPinnedClickRefused).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("middle-click on an UNpinned pill still calls onClose (no regression)", () => {
    const onClose = vi.fn();
    const onPinnedClickRefused = vi.fn();
    render(
      <TabPill
        title="note.md"
        isActive={false}
        isDeleted={false}
        isPinned={false}
        onSelect={vi.fn()}
        onClose={onClose}
        onPinnedClickRefused={onPinnedClickRefused}
      />,
    );
    const pill = screen.getByRole("tab");
    fireEvent(
      pill,
      new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPinnedClickRefused).not.toHaveBeenCalled();
  });

  it("pill root carries user-select:none so tab titles are never selectable", () => {
    render(
      <TabPill
        title="note.md"
        isActive={false}
        isDeleted={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const pill = screen.getByRole("tab");
    expect(pill.style.userSelect).toBe("none");
  });

  it("close-× is centered on the label, not bottom-pinned", () => {
    render(
      <TabPill
        title="note.md"
        isActive={false}
        isDeleted={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const closeBtn = screen.getByRole("button", { name: "Close note.md" });
    // The prior bottom-pin hack (alignSelf:"flex-end" +
    // marginBottom:6) is gone — the button now shares the pill row's own
    // alignItems:"center", landing on the same vertical center as the label.
    expect(closeBtn.style.alignSelf).toBe("");
    expect(closeBtn.style.marginBottom).toBe("");
  });
});

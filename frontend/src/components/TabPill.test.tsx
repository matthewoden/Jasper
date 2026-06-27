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

  it("active + non-deleted + non-empty breadcrumb renders a muted prefix AND the title", () => {
    render(
      <TabPill
        title="route.md"
        isActive={true}
        isDeleted={false}
        breadcrumb="docs / api"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const crumb = screen.getByTestId("tab-breadcrumb");
    expect(crumb.textContent).toContain("docs / api");
    expect((crumb.getAttribute("style") ?? "")).toContain("var(--color-muted)");
    expect(screen.getByText("route.md")).toBeDefined();
  });

  it("inactive pill renders NO breadcrumb even when one is supplied (title only)", () => {
    render(
      <TabPill
        title="route.md"
        isActive={false}
        isDeleted={false}
        breadcrumb="docs / api"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("tab-breadcrumb")).toBeNull();
    expect(screen.getByText("route.md")).toBeDefined();
  });

  it("empty breadcrumb (vault root) renders NO breadcrumb span, even when active", () => {
    render(
      <TabPill
        title="note.md"
        isActive={true}
        isDeleted={false}
        breadcrumb=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("tab-breadcrumb")).toBeNull();
    expect(screen.getByText("note.md")).toBeDefined();
  });

  it("deleted active pill shows '(deleted)' only — no breadcrumb", () => {
    render(
      <TabPill
        title="route.md"
        isActive={true}
        isDeleted={true}
        breadcrumb="docs / api"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("tab-breadcrumb")).toBeNull();
    expect(screen.getByText("(deleted)")).toBeDefined();
  });

  it("title-wins (structural): breadcrumb flexShrink is strictly greater than the title's", () => {
    render(
      <TabPill
        title="route.md"
        isActive={true}
        isDeleted={false}
        breadcrumb="docs / api"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const crumb = screen.getByTestId("tab-breadcrumb");
    const titleSpan = screen.getByText("route.md");
    const crumbShrink = Number(
      (crumb as HTMLElement).style.flexShrink || "1",
    );
    const titleShrink = Number(
      (titleSpan as HTMLElement).style.flexShrink || "1",
    );
    expect(crumbShrink).toBeGreaterThan(titleShrink);
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

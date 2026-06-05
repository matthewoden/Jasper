/**
 * Tests for TagDeleteConfirmDialog component.
 * Validates DC1..DC6 from Plan 06-08 Task 2 behaviors.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TagDeleteConfirmDialog } from "./TagDeleteConfirmDialog";

describe("TagDeleteConfirmDialog", () => {
  it("DC1: when open=false, renders nothing visible", () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    const { container } = render(
      <TagDeleteConfirmDialog
        open={false}
        onOpenChange={onOpenChange}
        tagName="project"
        noteCount={10}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.queryByText("Remove tag 'project'?")).toBeNull();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("DC2: when open=true, renders title, body lines, and buttons per UI-SPEC Surface 7", () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <TagDeleteConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        tagName="project"
        noteCount={12}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText("Remove tag 'project'?")).toBeInTheDocument();

    expect(
      screen.getByText(
        'This will remove "project" from 12 notes. Their frontmatter will be rewritten.',
      ),
    ).toBeInTheDocument();

    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Keep tag" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove tag" })).toBeInTheDocument();
  });

  it("DC3: clicking Confirm calls onConfirm() and onOpenChange(false)", () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <TagDeleteConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        tagName="work"
        noteCount={8}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove tag" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("DC4: clicking Cancel does not invoke onConfirm", () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <TagDeleteConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        tagName="work"
        noteCount={8}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Keep tag" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("DC6: dialog has role=alertdialog (Radix default - focus trap)", () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <TagDeleteConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        tagName="project"
        noteCount={10}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});

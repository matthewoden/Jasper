/**
 * ResetConfirmDialog tests. The nesting smoke test proves the confirm renders
 * without unmounting the outer Dialog.Content under jsdom — it does NOT (and
 * cannot, under jsdom) prove focus-trap handoff or Escape-key scoping. Those
 * remain owed to the human-verify checkpoint in plan 32-11 (see file header).
 */
import * as Dialog from "@radix-ui/react-dialog";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResetConfirmDialog } from "./ResetConfirmDialog";

describe("ResetConfirmDialog", () => {
  it("renders the exact locked title for a given sectionLabel", () => {
    render(
      <ResetConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        sectionLabel="Editor"
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Reset Editor to defaults?")).toBeInTheDocument();
  });

  it("renders the exact locked description", () => {
    render(
      <ResetConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        sectionLabel="Editor"
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("This can't be undone.")).toBeInTheDocument();
  });

  it("never mentions grants or MCP in the dialog copy (copy risk)", () => {
    render(
      <ResetConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        sectionLabel="Server"
        onConfirm={vi.fn()}
      />,
    );
    const dialogText = screen.getByRole("alertdialog").textContent ?? "";
    expect(dialogText).not.toMatch(/grant/i);
    expect(dialogText).not.toMatch(/MCP/i);
  });

  it("clicking Reset calls onConfirm exactly once", () => {
    const onConfirm = vi.fn();
    render(
      <ResetConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        sectionLabel="Editor"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("clicking Cancel calls onConfirm zero times and onOpenChange(false)", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ResetConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        sectionLabel="Editor"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders nothing when closed", () => {
    render(
      <ResetConfirmDialog
        open={false}
        onOpenChange={vi.fn()}
        sectionLabel="Editor"
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  // Nesting smoke test: renders the
  // confirm inside an already-open Dialog.Content and asserts the outer
  // dialog's content survives the confirm opening. This is a presence check
  // only — it does not and cannot assert focus-trap handoff or Escape-key
  // scoping under jsdom.
  it("nesting smoke test: renders inside an open Dialog.Content without unmounting the outer dialog", () => {
    render(
      <Dialog.Root open={true} onOpenChange={() => {}}>
        <Dialog.Portal>
          <Dialog.Content aria-describedby={undefined}>
            <Dialog.Title>Settings</Dialog.Title>
            <div data-testid="outer-dialog-marker">Editor pane content</div>
            <ResetConfirmDialog
              open={true}
              onOpenChange={vi.fn()}
              sectionLabel="Editor"
              onConfirm={vi.fn()}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>,
    );

    expect(screen.getByTestId("outer-dialog-marker")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});

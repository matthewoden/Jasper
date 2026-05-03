/**
 * DeleteConfirmDialog tests — UI-SPEC §Surface 4.
 *
 * Verifies the locked copy variants for note vs. folder deletion,
 * pluralization rules for folder content counts, the destructive
 * Confirm-button color treatment, and the async onConfirm path.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DeleteConfirmDialog } from "./DeleteConfirmDialog";

describe("<DeleteConfirmDialog /> — note variant", () => {
  it("TestDialog_NoteVariant_RendersTitle", () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{ kind: "note", name: "foo.md" }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText("Delete this note?")).toBeInTheDocument();
  });

  it("TestDialog_NoteVariant_BodyLines", () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{ kind: "note", name: "foo.md" }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(
      screen.getByText(
        "foo.md will be permanently removed from disk and from the index.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your other notes are not touched — only this file is affected.",
      ),
    ).toBeInTheDocument();
  });

  it("TestDialog_NoteVariant_ConfirmLabel", () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{ kind: "note", name: "foo.md" }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Delete note" }),
    ).toBeInTheDocument();
  });
});

describe("<DeleteConfirmDialog /> — folder variant", () => {
  it("TestDialog_FolderVariant_Empty", () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{
          kind: "folder",
          name: "x",
          noteCount: 0,
          subfolderCount: 0,
        }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText("Delete this folder?")).toBeInTheDocument();
    expect(
      screen.getByText(
        "x will be permanently removed from disk and from the index.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your other notes are not touched — only this folder is affected.",
      ),
    ).toBeInTheDocument();
    // Empty-folder copy is NOT destructive
    const reassurance = screen.getByText(
      "Your other notes are not touched — only this folder is affected.",
    );
    expect(reassurance.style.color).not.toContain("destructive");
  });

  it("TestDialog_FolderVariant_OneNoteOnly", () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{
          kind: "folder",
          name: "x",
          noteCount: 1,
          subfolderCount: 0,
        }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    // Body line 1 should contain "1 note" (singular)
    const line1 = screen.getByText(
      /x contains 1 note\. All of them will be permanently removed/,
    );
    expect(line1).toBeInTheDocument();
    // Should NOT contain "1 notes" (plural for 1)
    expect(screen.queryByText(/1 notes/)).toBeNull();
  });

  it("TestDialog_FolderVariant_MultipleNotesAndSubfolders", () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{
          kind: "folder",
          name: "x",
          noteCount: 5,
          subfolderCount: 2,
        }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(
      screen.getByText(
        "x contains 5 notes and 2 subfolders. All of them will be permanently removed from disk and from the index.",
      ),
    ).toBeInTheDocument();
    const line2 = screen.getByText("This cannot be undone.");
    expect(line2).toBeInTheDocument();
    // line2 has destructive color
    expect(line2.style.color).toContain("destructive");
  });

  it("TestDialog_FolderVariant_ConfirmLabel", () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{
          kind: "folder",
          name: "x",
          noteCount: 0,
          subfolderCount: 0,
        }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Delete folder" }),
    ).toBeInTheDocument();
  });
});

describe("<DeleteConfirmDialog /> — interaction", () => {
  it("TestDialog_ConfirmButton_HasDestructiveColor", () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{ kind: "note", name: "foo.md" }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const confirm = screen.getByRole("button", { name: "Delete note" });
    expect(confirm.style.background).toContain("destructive");
  });

  it("TestDialog_ConfirmCallsOnConfirm", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{ kind: "note", name: "foo.md" }}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });

  it("TestDialog_CancelClosesDialog", () => {
    const onOpenChange = vi.fn();
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        target={{ kind: "note", name: "foo.md" }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("TestDialog_OnConfirmAsync_KeepsDialogOpenUntilResolves", async () => {
    let resolveConfirm: () => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveConfirm = r;
        }),
    );
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{ kind: "note", name: "foo.md" }}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
    // While the promise is in flight, dialog stays mounted.
    expect(screen.getByText("Delete this note?")).toBeInTheDocument();
    resolveConfirm();
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });
});

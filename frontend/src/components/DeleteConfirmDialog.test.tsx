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
        target={{ kind: "note", name: "foo.md", id: "uuid-foo" }}
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
        target={{ kind: "note", name: "foo.md", id: "uuid-foo" }}
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
        target={{ kind: "note", name: "foo.md", id: "uuid-foo" }}
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
          path: "x",
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
          path: "x",
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
          path: "x",
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
          path: "x",
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
        target={{ kind: "note", name: "foo.md", id: "uuid-foo" }}
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
        target={{ kind: "note", name: "foo.md", id: "uuid-foo" }}
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
        target={{ kind: "note", name: "foo.md", id: "uuid-foo" }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("UX-13: multi variant renders 'Delete N items?' title with the correct count", () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{ kind: "multi", count: 5 }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    // Title copy locked by the plan must-have truth: "Delete N items?".
    expect(screen.getByText("Delete 5 items?")).toBeInTheDocument();
    // Body line 1 references the count again so the dialog is unambiguous
    // even when scanned without the title.
    expect(
      screen.getByText(
        /This will permanently delete the selected 5 items from disk and from the index\./,
      ),
    ).toBeInTheDocument();
    // Destructive second line — matches the folder-with-contents posture.
    const line2 = screen.getByText("This cannot be undone.");
    expect(line2).toBeInTheDocument();
    expect(line2.style.color).toContain("destructive");
  });

  it("UX-13: multi variant onConfirm callback fires when Delete clicked", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{ kind: "multi", count: 3 }}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete 3 items" }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
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
        target={{ kind: "note", name: "foo.md", id: "uuid-foo" }}
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

// ──────────────────────────────────────────────────────────────────────────
// WR-09 (Phase 5.5 gap-closure Plan 13) — DeleteTarget type contract.
//
// The DeleteTarget union now carries the canonical identifier directly:
//   - { kind: "note"; name: string; id: string }
//   - { kind: "folder"; name: string; path: string; noteCount, subfolderCount }
//   - { kind: "multi"; count: number }    // unchanged
//
// FileTree.handleConfirmDelete reads `target.id` / `target.path` directly
// instead of re-deriving from the display name (the previous lookup was
// ambiguous when two notes shared a basename across subtrees).
//
// We use `// @ts-expect-error` to assert that omitting the new required
// fields is a TypeScript error — the directive itself becomes an error if
// the line type-checks, so `tsc --noEmit` enforces the contract.
// ──────────────────────────────────────────────────────────────────────────
describe("WR-09 — DeleteTarget carries canonical id/path", () => {
  it("WR-09 / Test 1: note variant requires `id: string`", () => {
    const validNote: import("./deleteConfirmDialog.utils").DeleteTarget = {
      kind: "note",
      name: "foo.md",
      id: "uuid-foo",
    };
    expect(validNote.kind).toBe("note");

    // @ts-expect-error — note variant without `id` must be a type error.
    const missingId: import("./deleteConfirmDialog.utils").DeleteTarget = {
      kind: "note",
      name: "foo.md",
    };
    // Reference the value so it isn't tree-shaken — we only care that the
    // assignment above is a type error, not that the runtime branch differs.
    expect(missingId.kind).toBe("note");
  });

  it("WR-09 / Test 2: folder variant requires `path: string`", () => {
    const validFolder: import("./deleteConfirmDialog.utils").DeleteTarget = {
      kind: "folder",
      name: "projects",
      path: "projects",
      noteCount: 0,
      subfolderCount: 0,
    };
    expect(validFolder.kind).toBe("folder");

    // @ts-expect-error — folder variant without `path` must be a type error.
    const missingPath: import("./deleteConfirmDialog.utils").DeleteTarget = {
      kind: "folder",
      name: "projects",
      noteCount: 0,
      subfolderCount: 0,
    };
    expect(missingPath.kind).toBe("folder");
  });

  it("WR-09 / Test 3: multi variant is unchanged ({ kind, count } only)", () => {
    const validMulti: import("./deleteConfirmDialog.utils").DeleteTarget = {
      kind: "multi",
      count: 5,
    };
    expect(validMulti.kind).toBe("multi");
    if (validMulti.kind === "multi") {
      expect(validMulti.count).toBe(5);
    }
  });

  it("WR-09: note variant `id` field is rendered transparently (dialog still shows the name)", () => {
    // The dialog body must not leak the id into the user-visible copy —
    // the id is purely for the caller's bookkeeping. The dialog continues
    // to display the human-readable `name` only.
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{ kind: "note", name: "subdir/Foo.md", id: "uuid-deep" }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(
      screen.getByText(
        "subdir/Foo.md will be permanently removed from disk and from the index.",
      ),
    ).toBeInTheDocument();
    // The id should NOT appear anywhere in the dialog DOM.
    expect(screen.queryByText(/uuid-deep/)).toBeNull();
  });

  it("WR-09: folder variant `path` field is rendered transparently (dialog still shows the name)", () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{
          kind: "folder",
          name: "projects/sub",
          path: "projects/sub",
          noteCount: 0,
          subfolderCount: 0,
        }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(
      screen.getByText(
        "projects/sub will be permanently removed from disk and from the index.",
      ),
    ).toBeInTheDocument();
  });
});

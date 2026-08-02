/**
 * DeleteConfirmDialog tests — the locked copy contract.
 *
 * Verifies the locked trash-based copy variants for note / folder / multi
 * (bulk) / file deletion, the destructive Confirm-button color treatment,
 * and the async onConfirm path.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DeleteConfirmDialog } from "./DeleteConfirmDialog";

describe("<DeleteConfirmDialog /> — note variant (trash copy)", () => {
  it("TestDialog_NoteVariant_RendersTitle", () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{ kind: "note", name: "foo.md", id: "uuid-foo" }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText("Delete note?")).toBeInTheDocument();
  });

  it("TestDialog_NoteVariant_BodyLine", () => {
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
        '"foo.md" will be moved to Trash. You can restore it from Trash later.',
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
      screen.getByRole("button", { name: "Delete" }),
    ).toBeInTheDocument();
  });
});

describe("<DeleteConfirmDialog /> — folder variant (trash copy)", () => {
  it("TestDialog_FolderVariant_RendersTitleAndBody", () => {
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
    expect(screen.getByText("Delete folder?")).toBeInTheDocument();
    expect(
      screen.getByText(
        '"x" and everything inside it will be moved to Trash. You can restore it from Trash later.',
      ),
    ).toBeInTheDocument();
  });

  it("TestDialog_FolderVariant_CopyIsIdenticalRegardlessOfContentsCount", () => {
    // the locked copy is a single generic sentence — it does not
    // vary by noteCount/subfolderCount (unlike the pre-Phase-30 dialog).
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
        '"x" and everything inside it will be moved to Trash. You can restore it from Trash later.',
      ),
    ).toBeInTheDocument();
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
      screen.getByRole("button", { name: "Delete" }),
    ).toBeInTheDocument();
  });
});

describe("<DeleteConfirmDialog /> — file variant (no Trash path — attachments hard-delete)", () => {
  it("TestDialog_FileVariant_RendersImmediateDeleteCopy", () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{ kind: "file", name: "photo.png", path: "attachments/photo.png" }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText("Delete this file?")).toBeInTheDocument();
    expect(
      screen.getByText(
        '"photo.png" will be deleted immediately. This cannot be undone.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete file" }),
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
    const confirm = screen.getByRole("button", { name: "Delete" });
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
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
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

  it("multi variant renders 'Delete N notes?' title with the correct count", () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{ kind: "multi", count: 5 }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText("Delete 5 notes?")).toBeInTheDocument();
    expect(
      screen.getByText(
        "They will be moved to Trash. You can restore them from Trash later.",
      ),
    ).toBeInTheDocument();
  });

  it("multi variant onConfirm callback fires when Delete clicked", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        target={{ kind: "multi", count: 3 }}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete 3 notes" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete note?")).toBeInTheDocument();
    resolveConfirm();
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });
});


describe("DeleteTarget carries canonical id/path", () => {
  it("Test 1: note variant requires `id: string`", () => {
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
    expect(missingId.kind).toBe("note");
  });

  it("Test 2: folder variant requires `path: string`", () => {
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

  it("Test 3: multi variant is unchanged ({ kind, count } only)", () => {
    const validMulti: import("./deleteConfirmDialog.utils").DeleteTarget = {
      kind: "multi",
      count: 5,
    };
    expect(validMulti.kind).toBe("multi");
    if (validMulti.kind === "multi") {
      expect(validMulti.count).toBe(5);
    }
  });

  it("note variant `id` field is rendered transparently (dialog still shows the name)", () => {
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
        '"subdir/Foo.md" will be moved to Trash. You can restore it from Trash later.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/uuid-deep/)).toBeNull();
  });

  it("folder variant `path` field is rendered transparently (dialog still shows the name)", () => {
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
        '"projects/sub" and everything inside it will be moved to Trash. You can restore it from Trash later.',
      ),
    ).toBeInTheDocument();
  });
});

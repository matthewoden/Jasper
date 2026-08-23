import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BookmarkFolderRenameInput } from "./BookmarkFolderRenameInput";

function renameTo(next: string) {
  const input = screen.getByLabelText("Bookmark folder name");
  fireEvent.change(input, { target: { value: next } });
  fireEvent.keyDown(input, { key: "Enter" });
  return input as HTMLInputElement;
}

describe("BookmarkFolderRenameInput", () => {
  it("keeps the typed text and shows the reason when the rename is refused", async () => {
    const onCommit = vi
      .fn()
      .mockRejectedValue(new Error("a folder with this name already exists"));
    const onCancel = vi.fn();
    render(
      <BookmarkFolderRenameInput
        initialValue="Personal"
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );

    const input = renameTo("Work");

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "a folder with this name already exists",
      );
    });
    expect(input.value).toBe("Work");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("lets the user correct a refused name and commit again", async () => {
    const onCommit = vi
      .fn()
      .mockRejectedValueOnce(new Error("a folder with this name already exists"))
      .mockResolvedValueOnce(undefined);
    render(
      <BookmarkFolderRenameInput
        initialValue="Personal"
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );

    renameTo("Work");
    await screen.findByRole("alert");

    renameTo("Archive");

    await waitFor(() => {
      expect(onCommit).toHaveBeenNthCalledWith(2, "Archive");
    });
  });
});

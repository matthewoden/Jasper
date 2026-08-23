/**
 * A rejected commit — the backend refusing a duplicate folder name with 409 —
 * must leave the input mounted with the typed text intact so the user can
 * correct it, rather than closing or clearing.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NewBookmarkFolderInput } from "./NewBookmarkFolderInput";

function getInput(): HTMLInputElement {
  return screen.getByLabelText("New bookmark folder name") as HTMLInputElement;
}

describe("NewBookmarkFolderInput", () => {
  it("keeps the typed text and shows an inline error when the commit is rejected", async () => {
    const user = userEvent.setup();
    const onCommit = vi
      .fn()
      .mockRejectedValue(new Error("a folder with this name already exists"));
    const onCancel = vi.fn();

    render(<NewBookmarkFolderInput onCommit={onCommit} onCancel={onCancel} />);

    await user.type(getInput(), "Work");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "a folder with this name already exists",
      );
    });
    expect(getInput().value).toBe("Work");
    expect(getInput()).toHaveAttribute("aria-invalid", "true");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("lets the user correct the name and commit again after a rejection", async () => {
    const user = userEvent.setup();
    const onCommit = vi
      .fn()
      .mockRejectedValueOnce(new Error("a folder with this name already exists"))
      .mockResolvedValueOnce(undefined);

    render(<NewBookmarkFolderInput onCommit={onCommit} onCancel={vi.fn()} />);

    await user.type(getInput(), "Work");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    await user.clear(getInput());
    await user.type(getInput(), "Personal");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
    expect(onCommit).toHaveBeenLastCalledWith("Personal");
  });

  it("clears the inline error as soon as the user edits the name", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn().mockRejectedValue(new Error("taken"));

    render(<NewBookmarkFolderInput onCommit={onCommit} onCancel={vi.fn()} />);

    await user.type(getInput(), "Work");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    await user.type(getInput(), "s");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

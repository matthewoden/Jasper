/**
 * MoveToFolderModal tests (D-23):
 *   - typing a query fuzzy-filters the vault folder list; "No matching
 *     folders" shows when nothing matches
 *   - a "Vault root" row is present and selectable (moves to the vault root)
 *   - Enter on the highlighted folder calls moveNote(noteId, composedPath)
 *     — POST /notes/{id}/move's new_path wants the FULL destination path
 *     (target folder + the note's own basename), not just the folder — and
 *     closes; Esc dismisses without moving
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/useFileTree", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/useFileTree")>("../lib/useFileTree");
  return { ...actual, useFileTree: vi.fn() };
});

const moveNoteMock = vi.fn();
vi.mock("../lib/useTreeMutations", () => ({
  useTreeMutations: () => ({ moveNote: moveNoteMock }),
}));

const toastMock = vi.fn();
vi.mock("./toast.utils", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { useFileTree } from "../lib/useFileTree";
import { MoveToFolderModal } from "./MoveToFolderModal";
import type { Tree } from "../lib/treeApi";

const mockUseFileTree = vi.mocked(useFileTree);

const FAKE_TREE: Tree = {
  root: [
    {
      kind: "folder",
      path: "Projects",
      name: "Projects",
      children: [
        {
          kind: "folder",
          path: "Projects/Archive",
          name: "Archive",
          children: [],
        },
        {
          kind: "note",
          id: "note-1",
          path: "Projects/note.md",
          title: "note",
          updated_at: "2025-01-01T00:00:00Z",
        },
      ],
    },
  ],
};

function renderModal(overrides?: { onOpenChange?: (open: boolean) => void }) {
  const onOpenChange = overrides?.onOpenChange ?? vi.fn();
  render(
    <MoveToFolderModal
      noteId="note-1"
      notePath="Projects/note.md"
      open={true}
      onOpenChange={onOpenChange}
    />,
  );
  return { onOpenChange };
}

beforeEach(() => {
  moveNoteMock.mockReset();
  moveNoteMock.mockResolvedValue({ id: "note-1", path: "Projects/note.md" });
  toastMock.mockReset();
  mockUseFileTree.mockReturnValue({
    tree: FAKE_TREE,
    loading: false,
    error: null,
    refresh: vi.fn(),
    mutate: vi.fn(),
  });
});

describe("<MoveToFolderModal />", () => {
  it("shows every vault folder plus Vault root when the query is empty", async () => {
    renderModal();
    expect(await screen.findByText("Vault root")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Projects/Archive")).toBeInTheDocument();
  });

  it("fuzzy-filters the folder list as the user types", async () => {
    const user = userEvent.setup();
    renderModal();
    const input = await screen.findByRole("textbox");
    await user.type(input, "Archive");
    await waitFor(() => {
      expect(screen.getByText("Projects/Archive")).toBeInTheDocument();
      expect(screen.queryByText("Vault root")).not.toBeInTheDocument();
    });
  });

  it('shows "No matching folders" when nothing matches', async () => {
    const user = userEvent.setup();
    renderModal();
    const input = await screen.findByRole("textbox");
    await user.type(input, "zzzzzznomatch");
    expect(await screen.findByText("No matching folders")).toBeInTheDocument();
  });

  it("clicking the Vault root row moves the note to the vault root, preserving its filename", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderModal();
    const root = await screen.findByText("Vault root");
    await user.click(root);
    await waitFor(() => {
      expect(moveNoteMock).toHaveBeenCalledWith("note-1", "note.md");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("pressing Enter on the highlighted folder moves the note (composing folder + filename) and closes", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderModal();
    const input = await screen.findByRole("textbox");
    await user.type(input, "Archive");
    await waitFor(() => {
      expect(screen.getByText("Projects/Archive")).toBeInTheDocument();
    });
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(moveNoteMock).toHaveBeenCalledWith("note-1", "Projects/Archive/note.md");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("Esc dismisses without moving the note", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderModal();
    await screen.findByRole("textbox");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(moveNoteMock).not.toHaveBeenCalled();
  });
});

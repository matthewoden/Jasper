/**
 * FileTree tests — UI-SPEC §Surface 1.
 *
 * Mocks useFileTree to drive each state branch (loading / error / empty /
 * populated). Asserts the adapter that converts the wire TreeNode shape
 * to react-arborist's expected `{id, name, children?}` shape.
 *
 * react-arborist actually renders into the DOM under jsdom — its
 * virtualization defaults to react-window which mounts the visible window
 * of rows synchronously when given a finite height.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Tree } from "../lib/treeApi";
import { useTreeStore } from "../lib/useTreeStore";
import { FileTree, adaptToArborist } from "./FileTree";

// ──────────────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────────────
vi.mock("../lib/useFileTree", () => ({
  useFileTree: vi.fn(),
}));

import { useFileTree } from "../lib/useFileTree";
const mockedUseFileTree = vi.mocked(useFileTree);

beforeEach(() => {
  useTreeStore.setState({
    expanded: new Set(),
    activeNoteId: null,
    pendingRename: null,
    draftCreate: null,
  });
});

afterEach(() => {
  mockedUseFileTree.mockReset();
});

const noopRefresh = () => Promise.resolve();
const noopMutate = () => {};

describe("<FileTree />", () => {
  it("TestFileTree_LoadingState_RendersStripe", () => {
    mockedUseFileTree.mockReturnValue({
      tree: null,
      loading: true,
      error: null,
      refresh: noopRefresh,
      mutate: noopMutate,
    });
    render(<FileTree onSelectNote={vi.fn()} />);
    expect(screen.getByTestId("tree-loading")).toBeInTheDocument();
  });

  it("TestFileTree_ErrorState", () => {
    mockedUseFileTree.mockReturnValue({
      tree: null,
      loading: false,
      error: new Error("boom"),
      refresh: noopRefresh,
      mutate: noopMutate,
    });
    render(<FileTree onSelectNote={vi.fn()} />);
    expect(screen.getByTestId("tree-error-state")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load the tree.")).toBeInTheDocument();
  });

  it("TestFileTree_EmptyState_NoNotes", () => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] } as Tree,
      loading: false,
      error: null,
      refresh: noopRefresh,
      mutate: noopMutate,
    });
    render(<FileTree onSelectNote={vi.fn()} />);
    expect(screen.getByTestId("tree-empty-state")).toBeInTheDocument();
  });

  it("TestFileTree_RendersTree_WithRoots", async () => {
    const tree: Tree = {
      root: [
        {
          kind: "folder",
          path: "projects",
          name: "projects",
          children: [],
        },
        {
          kind: "note",
          id: "uuid-scratch",
          path: "scratchpad.md",
          title: "Scratchpad",
          updated_at: new Date().toISOString(),
        },
      ],
    };
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: noopRefresh,
      mutate: noopMutate,
    });
    render(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("projects")).toBeInTheDocument();
      expect(screen.getByText("Scratchpad")).toBeInTheDocument();
    });
  });

  it("TestFileTree_NestedFolderExpands", async () => {
    const tree: Tree = {
      root: [
        {
          kind: "folder",
          path: "projects",
          name: "projects",
          children: [
            {
              kind: "note",
              id: "uuid-readme",
              path: "projects/readme.md",
              title: "Readme",
              updated_at: new Date().toISOString(),
            },
          ],
        },
      ],
    };
    // Pre-set the expanded path so FileTree's initialOpenState includes it.
    useTreeStore.setState({ expanded: new Set(["projects"]) });
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: noopRefresh,
      mutate: noopMutate,
    });
    render(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      // Both the parent folder label AND the child note label should
      // be present — confirming the tree mounted with the folder open.
      expect(screen.getByText("projects")).toBeInTheDocument();
      expect(screen.getByText("Readme")).toBeInTheDocument();
    });
  });

  it("TestFileTree_OnSelectNote_PassesId", async () => {
    const tree: Tree = {
      root: [
        {
          kind: "note",
          id: "uuid-scratch",
          path: "scratchpad.md",
          title: "Scratchpad",
          updated_at: new Date().toISOString(),
        },
      ],
    };
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: noopRefresh,
      mutate: noopMutate,
    });
    const onSelectNote = vi.fn();
    render(<FileTree onSelectNote={onSelectNote} />);
    await waitFor(() => {
      expect(screen.getByText("Scratchpad")).toBeInTheDocument();
    });
    // Click the row containing the note label.
    const row = document.querySelector(
      '[data-tree-row="uuid-scratch"]',
    ) as HTMLElement;
    expect(row).not.toBeNull();
    fireEvent.click(row);
    expect(onSelectNote).toHaveBeenCalledWith("uuid-scratch");
  });

  it("TestFileTree_AdaptToArborist_PrefixesIds — folder keeps wire shape in data; arborist gets unique id", () => {
    const folder = adaptToArborist({
      kind: "folder",
      path: "projects",
      name: "projects",
      children: [],
    });
    expect(folder.id).toBe("folder:projects");
    expect(folder.name).toBe("projects");
    expect(folder.data).toEqual({
      kind: "folder",
      path: "projects",
      name: "projects",
    });
    expect(folder.children).toEqual([]);

    const note = adaptToArborist({
      kind: "note",
      id: "uuid-1",
      path: "scratchpad.md",
      title: "Scratchpad",
      updated_at: "2026-01-01T00:00:00Z",
    });
    expect(note.id).toBe("note:uuid-1");
    expect(note.name).toBe("Scratchpad");
    expect(note.data).toEqual({
      kind: "note",
      id: "uuid-1",
      path: "scratchpad.md",
      title: "Scratchpad",
    });
    expect(note.children).toBeUndefined();
  });

  it("returns null cleanly when tree is null AND not loading AND no error (idle limbo)", () => {
    mockedUseFileTree.mockReturnValue({
      tree: null,
      loading: false,
      error: null,
      refresh: noopRefresh,
      mutate: noopMutate,
    });
    const { container } = render(<FileTree onSelectNote={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

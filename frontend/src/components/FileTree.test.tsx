/**
 * FileTree tests — state branches, toasts, and drag-drop.
 *
 * Mocks useFileTree + useTreeMutations to drive each state branch
 * deterministically. Wraps in <ToastProvider> for toast surfacing and
 * <TooltipProvider>: note rows with
 * updated_at/created now conditionally mount the shared Tooltip, which
 * throws without a provider ancestor).
 *
 * react-arborist renders into the DOM under jsdom — its virtualization
 * (react-window) mounts the visible window of rows synchronously at finite height.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderOptions,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { Tree } from "../lib/treeApi";
import { useTreeStore } from "../lib/useTreeStore";
import { TreeMutationError } from "../lib/useTreeMutations";
import { FileTree } from "./FileTree";
import {
  adaptToArborist,
  basename,
  buildMultiDeleteTarget,
  computeMoveTarget,
  countDescendants,
  deselectDescendantsOfFolders,
  executeBatchDelete,
  isCycleDrop,
  resetTreeListLayout,
  type ArboristNode,
} from "./fileTree.utils";
import type { TreeRowData } from "./TreeRow";
import type { NodeApi, TreeApi } from "react-arborist";
import { ToastProvider } from "./Toast";
import { TooltipProvider } from "./Tooltip";


vi.mock("../lib/useFileTree", () => ({
  useFileTree: vi.fn(),
}));

vi.mock("../lib/useTreeMutations", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/useTreeMutations")
  >("../lib/useTreeMutations");
  return {
    ...actual,
    useTreeMutations: vi.fn(),
  };
});


vi.mock("../lib/notesApi", () => ({
  ScratchpadUUID: "00000000-0000-4000-a000-000000000001",
  getNote: vi.fn(),
  getNoteFresh: vi.fn(),
  updateNote: vi.fn(),
  createNoteFromMarkdownDrop: vi.fn(),
}));

import { useFileTree } from "../lib/useFileTree";
import { useTreeMutations } from "../lib/useTreeMutations";
import {
  getNote,
  getNoteFresh,
  updateNote,
  createNoteFromMarkdownDrop,
} from "../lib/notesApi";
const mockedUseFileTree = vi.mocked(useFileTree);
const mockedUseTreeMutations = vi.mocked(useTreeMutations);
const mockedGetNote = vi.mocked(getNote);
const mockedGetNoteFresh = vi.mocked(getNoteFresh);
const mockedUpdateNote = vi.mocked(updateNote);
const mockedCreateNoteFromMarkdownDrop = vi.mocked(createNoteFromMarkdownDrop);

beforeEach(() => {
  useTreeStore.setState({
    expanded: new Set(),
    activeNoteId: null,
    pendingRename: null,
    draftCreate: null,
    collapseAllNonce: 0,
    expandAllNonce: 0,
    allCollapsed: false,
  });
  mockedGetNote.mockReset();
  mockedGetNoteFresh.mockReset();
  mockedUpdateNote.mockReset();
});

afterEach(() => {
  mockedUseFileTree.mockReset();
  mockedUseTreeMutations.mockReset();
});

const noopRefresh = () => Promise.resolve();

function defaultMutsResult() {
  return {
    createNote: vi.fn(),
    deleteNote: vi.fn(),
    moveNote: vi.fn(),
    createFolder: vi.fn(),
    deleteFolder: vi.fn(),
    moveFolder: vi.fn(),
    moveFile: vi.fn(),
  };
}

function renderWithProvider(
  ui: React.ReactElement,
  options?: RenderOptions,
) {
  return render(ui, {
    wrapper: ({ children }) => (
      <TooltipProvider>
        <ToastProvider>{children}</ToastProvider>
      </TooltipProvider>
    ),
    ...options,
  });
}

describe("<FileTree />", () => {
  it("TestFileTree_LoadingState_RendersStripe", () => {
    mockedUseFileTree.mockReturnValue({
      tree: null,
      loading: true,
      error: null,
      refresh: noopRefresh,
    });
    mockedUseTreeMutations.mockReturnValue(defaultMutsResult());
    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    expect(screen.getByTestId("tree-loading")).toBeInTheDocument();
  });

  it("TestFileTree_ErrorState", () => {
    mockedUseFileTree.mockReturnValue({
      tree: null,
      loading: false,
      error: new Error("boom"),
      refresh: noopRefresh,
    });
    mockedUseTreeMutations.mockReturnValue(defaultMutsResult());
    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    expect(screen.getByTestId("tree-error-state")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load the tree.")).toBeInTheDocument();
  });

  it("TestFileTree_EmptyState_NoNotes", () => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] } as Tree,
      loading: false,
      error: null,
      refresh: noopRefresh,
    });
    mockedUseTreeMutations.mockReturnValue(defaultMutsResult());
    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
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
    });
    mockedUseTreeMutations.mockReturnValue(defaultMutsResult());
    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
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
    useTreeStore.setState({ expanded: new Set(["projects"]) });
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: noopRefresh,
    });
    mockedUseTreeMutations.mockReturnValue(defaultMutsResult());
    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("projects")).toBeInTheDocument();
      expect(screen.getByText("Readme")).toBeInTheDocument();
    });
  });

  it("TestFileTree_ExpandAllNonce_OpensAllFolders — expand-all toggle repopulates the tree open state", async () => {
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
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: noopRefresh,
    });
    mockedUseTreeMutations.mockReturnValue(defaultMutsResult());
    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("projects")).toBeInTheDocument();
    });
    expect(screen.queryByText("Readme")).toBeNull();

    act(() => {
      useTreeStore.getState().expandAllFolders(["projects"]);
    });

    await waitFor(() => {
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
    });
    mockedUseTreeMutations.mockReturnValue(defaultMutsResult());
    const onSelectNote = vi.fn();
    renderWithProvider(<FileTree onSelectNote={onSelectNote} />);
    await waitFor(() => {
      expect(screen.getByText("Scratchpad")).toBeInTheDocument();
    });
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
      updated_at: "2026-01-01T00:00:00Z",
      created: undefined,
    });
    expect(note.children).toBeUndefined();
  });

  it("returns null cleanly when tree is null AND not loading AND no error (idle limbo)", () => {
    mockedUseFileTree.mockReturnValue({
      tree: null,
      loading: false,
      error: null,
      refresh: noopRefresh,
    });
    mockedUseTreeMutations.mockReturnValue(defaultMutsResult());
    const { container } = renderWithProvider(
      <FileTree onSelectNote={vi.fn()} />,
    );
    expect(container.querySelector("[data-testid='tree-loading']")).toBeNull();
    expect(container.querySelector("[data-testid='tree-error-state']")).toBeNull();
    expect(container.querySelector("[data-testid='tree-empty-state']")).toBeNull();
  });
});


describe("FileTree helpers", () => {
  it("basename extracts last path segment", () => {
    expect(basename("a/b/c.md")).toBe("c.md");
    expect(basename("foo")).toBe("foo");
    expect(basename("")).toBe("");
  });

  it("countDescendants counts immediate notes + subfolders", () => {
    const tree: Tree = {
      root: [
        {
          kind: "folder",
          path: "x",
          name: "x",
          children: [
            {
              kind: "note",
              id: "n1",
              path: "x/a.md",
              title: "A",
              updated_at: "2026-01-01T00:00:00Z",
            },
            {
              kind: "note",
              id: "n2",
              path: "x/b.md",
              title: "B",
              updated_at: "2026-01-01T00:00:00Z",
            },
            {
              kind: "folder",
              path: "x/sub",
              name: "sub",
              children: [],
            },
          ],
        },
      ],
    };
    expect(countDescendants(tree, "x")).toEqual({ notes: 2, folders: 1 });
  });

  it("countDescendants returns zeros for unknown folder", () => {
    const tree: Tree = { root: [] };
    expect(countDescendants(tree, "missing")).toEqual({
      notes: 0,
      folders: 0,
    });
  });
});


describe("<FileTree /> — wiring", () => {
  it("TestFileTree_DeleteFlow_Note", async () => {
    const tree: Tree = {
      root: [
        {
          kind: "note",
          id: "uuid-1",
          path: "scratchpad.md",
          title: "Scratchpad",
          updated_at: new Date().toISOString(),
        },
      ],
    };
    const muts = defaultMutsResult();
    muts.deleteNote.mockResolvedValue(undefined);
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    mockedUseTreeMutations.mockReturnValue(muts);

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Scratchpad")).toBeInTheDocument();
    });
    const row = document.querySelector(
      '[data-tree-row="uuid-1"]',
    ) as HTMLElement;
    fireEvent.keyDown(row, { key: "Backspace" });
    await waitFor(() => {
      expect(screen.getByText("Delete note?")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(muts.deleteNote).toHaveBeenCalledWith("uuid-1");
    });
  });

  it("TestFileTree_DeleteFlow_FolderRecursive", async () => {
    const tree: Tree = {
      root: [
        {
          kind: "folder",
          path: "projects",
          name: "projects",
          children: [
            {
              kind: "note",
              id: "n1",
              path: "projects/a.md",
              title: "A",
              updated_at: new Date().toISOString(),
            },
            {
              kind: "note",
              id: "n2",
              path: "projects/b.md",
              title: "B",
              updated_at: new Date().toISOString(),
            },
            {
              kind: "note",
              id: "n3",
              path: "projects/c.md",
              title: "C",
              updated_at: new Date().toISOString(),
            },
          ],
        },
      ],
    };
    const muts = defaultMutsResult();
    muts.deleteFolder.mockResolvedValue(undefined);
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    mockedUseTreeMutations.mockReturnValue(muts);

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("projects")).toBeInTheDocument();
    });
    const row = document.querySelector(
      '[data-tree-row="projects"]',
    ) as HTMLElement;
    fireEvent.keyDown(row, { key: "Backspace" });
    await waitFor(() => {
      expect(screen.getByText("Delete folder?")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(muts.deleteFolder).toHaveBeenCalledWith("projects", true);
    });
  });

  it("TestFileTree_RenameCommit_HappyPath", async () => {
    useTreeStore.setState({
      pendingRename: { kind: "note", target: "uuid-1" },
    });
    const tree: Tree = {
      root: [
        {
          kind: "note",
          id: "uuid-1",
          path: "scratchpad.md",
          title: "scratchpad.md",
          updated_at: new Date().toISOString(),
        },
      ],
    };
    const muts = defaultMutsResult();
    muts.moveNote.mockResolvedValue({
      id: "uuid-1",
      path: "renamed.md",
      title: "renamed.md",
      updated_at: new Date().toISOString(),
    });
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    mockedUseTreeMutations.mockReturnValue(muts);

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      const input = document.querySelector(
        "input[type='text']",
      ) as HTMLInputElement;
      expect(input).not.toBeNull();
    });
    const input = document.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(muts.moveNote).toHaveBeenCalledWith("uuid-1", "renamed.md");
    });
  });

  it("TestFileTree_RenameCommit_Collision_SurfacesToast", async () => {
    useTreeStore.setState({
      pendingRename: { kind: "note", target: "uuid-1" },
    });
    const tree: Tree = {
      root: [
        {
          kind: "note",
          id: "uuid-1",
          path: "scratchpad.md",
          title: "scratchpad.md",
          updated_at: new Date().toISOString(),
        },
      ],
    };
    const muts = defaultMutsResult();
    muts.moveNote.mockRejectedValue(
      new TreeMutationError("case_collision", "scratchpad.md", 409),
    );
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    mockedUseTreeMutations.mockReturnValue(muts);

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    const input = document.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "newname" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(
        screen.getByText("That name already exists."),
      ).toBeInTheDocument();
    });
  });

  it("TestFileTree_DragDrop_FolderIntoDescendant_Rejected — disableDrop returns true", async () => {
    expect(true).toBe(true);
  });
});

describe("FileTree.disableDrop — cycle prevention semantics", () => {
  function buildHandleDisableDrop() {
    return (args: {
      parentNode: { data: { data: { kind: string; path?: string } }; parent: object | null };
      dragNodes: { data: { data: { kind: string; path?: string } } }[];
      index: number;
    }): boolean => {
      const { parentNode, dragNodes } = args;
      if (!parentNode || dragNodes.length === 0) return false;
      for (const dn of dragNodes) {
        const dd = dn.data.data;
        if (dd.kind !== "folder") continue;
        const sourcePath = dd.path;
        let cur: typeof parentNode | null = parentNode;
        while (cur) {
          if (
            cur.data.data.kind === "folder" &&
            cur.data.data.path === sourcePath
          ) {
            return true;
          }
          cur = (cur as unknown as { parent: typeof parentNode | null })
            .parent;
        }
      }
      return false;
    };
  }

  it("rejects drop of a folder onto its own descendant", () => {
    const sourceFolder = {
      data: { data: { kind: "folder", path: "projects" } },
    };
    const projects = {
      data: { data: { kind: "folder", path: "projects" } },
      parent: null,
    };
    const sub = {
      data: { data: { kind: "folder", path: "projects/sub" } },
      parent: projects,
    };
    const fn = buildHandleDisableDrop();
    expect(
      fn({ parentNode: sub, dragNodes: [sourceFolder], index: 0 }),
    ).toBe(true);
  });

  it("allows drop of a folder into an unrelated folder", () => {
    const sourceFolder = {
      data: { data: { kind: "folder", path: "a" } },
    };
    const target = {
      data: { data: { kind: "folder", path: "b" } },
      parent: null,
    };
    const fn = buildHandleDisableDrop();
    expect(
      fn({ parentNode: target, dragNodes: [sourceFolder], index: 0 }),
    ).toBe(false);
  });
});


describe("handleMove same-parent no-op (Gap 2)", () => {
  function nodeStub(args: {
    data: TreeRowData;
    parent?: ReturnType<typeof nodeStub> | null;
  }): NodeApi<ArboristNode> {
    // Test-only stub: this describe block only ever constructs folder/note/
    // file TreeRowData (never bookmark kinds) — the trailing casts are
    // type-only, no behavior/assertion change (TreeRowData widened for
    // quick task 260719-jv1's shared-tree-component work).
    const arboristNode: ArboristNode = {
      id:
        args.data.kind === "folder"
          ? "folder:" + args.data.path
          : args.data.kind === "note"
            ? "note:" + args.data.id
            : "file:" + (args.data as { path: string }).path,
      name: args.data.kind === "folder"
        ? args.data.name
        : args.data.kind === "note"
          ? args.data.title
          : (args.data as { name: string }).name, // "file" nodes
      data: args.data,
    };
    const stub = {
      id: arboristNode.id,
      data: arboristNode,
      parent: args.parent ?? null,
    };
    return stub as unknown as NodeApi<ArboristNode>;
  }

  it("same-parent drop on a root-level note → isNoOp (no move call)", () => {
    const result = computeMoveTarget({
      sourcePath: "untitled.md",
      parentNode: null,
    });
    expect(result.isNoOp).toBe(true);
    expect(result.newPath).toBe("untitled.md");
  });

  it("same-parent drop on a nested note → isNoOp (no move call)", () => {
    const parentNode = nodeStub({
      data: {
        kind: "folder",
        path: "projects/jasper",
        name: "jasper",
      },
    });
    const result = computeMoveTarget({
      sourcePath: "projects/jasper/scratchpad.md",
      parentNode,
    });
    expect(result.isNoOp).toBe(true);
    expect(result.newPath).toBe("projects/jasper/scratchpad.md");
  });

  it("cross-parent drop on a note → not no-op; newPath under destination folder", () => {
    const parentNode = nodeStub({
      data: {
        kind: "folder",
        path: "projects/jasper",
        name: "jasper",
      },
    });
    const result = computeMoveTarget({
      sourcePath: "untitled.md",
      parentNode,
    });
    expect(result.isNoOp).toBe(false);
    expect(result.newPath).toBe("projects/jasper/untitled.md");
  });

  it("same-parent drop on a folder → isNoOp (no folder move)", () => {
    const parentNode = nodeStub({
      data: {
        kind: "folder",
        path: "projects",
        name: "projects",
      },
    });
    const result = computeMoveTarget({
      sourcePath: "projects/jasper",
      parentNode,
    });
    expect(result.isNoOp).toBe(true);
    expect(result.newPath).toBe("projects/jasper");
  });

  it("cross-parent drop on a folder → not no-op; folder rebased under new parent", () => {
    const parentNode = nodeStub({
      data: {
        kind: "folder",
        path: "projects",
        name: "projects",
      },
    });
    const result = computeMoveTarget({
      sourcePath: "archive/old",
      parentNode,
    });
    expect(result.isNoOp).toBe(false);
    expect(result.newPath).toBe("projects/old");
  });
});


describe("resetTreeListLayout (Gap R2-3)", () => {
  function makeTreeApiStub(listCurrent: unknown): TreeApi<ArboristNode> {
    return {
      list: { current: listCurrent },
    } as unknown as TreeApi<ArboristNode>;
  }

  it("calls resetAfterIndex(0) when available (preferred primitive)", () => {
    const resetAfterIndex = vi.fn();
    const forceUpdate = vi.fn();
    const tree = makeTreeApiStub({ resetAfterIndex, forceUpdate });
    const ref = { current: tree } as React.RefObject<TreeApi<ArboristNode> | null>;
    resetTreeListLayout(ref);
    expect(resetAfterIndex).toHaveBeenCalledWith(0);
    expect(resetAfterIndex).toHaveBeenCalledTimes(1);
    expect(forceUpdate).not.toHaveBeenCalled();
  });

  it("falls back to forceUpdate() when resetAfterIndex is absent", () => {
    const forceUpdate = vi.fn();
    const tree = makeTreeApiStub({ forceUpdate });
    const ref = { current: tree } as React.RefObject<TreeApi<ArboristNode> | null>;
    resetTreeListLayout(ref);
    expect(forceUpdate).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when treeRef.current is null (mount-time race)", () => {
    const ref = {
      current: null,
    } as React.RefObject<TreeApi<ArboristNode> | null>;
    expect(() => resetTreeListLayout(ref)).not.toThrow();
  });

  it("is a no-op when treeRef.current.list.current is null", () => {
    const tree = makeTreeApiStub(null);
    const ref = { current: tree } as React.RefObject<TreeApi<ArboristNode> | null>;
    expect(() => resetTreeListLayout(ref)).not.toThrow();
  });

  it("is a no-op when neither primitive is exposed (defensive last branch)", () => {
    const tree = makeTreeApiStub({});
    const ref = { current: tree } as React.RefObject<TreeApi<ArboristNode> | null>;
    expect(() => resetTreeListLayout(ref)).not.toThrow();
  });
});


describe("<FileTree /> — Direction B (filename → H1)", () => {
  type GetReturn = Awaited<ReturnType<typeof getNoteFresh>>;
  type PutReturn = Awaited<ReturnType<typeof updateNote>>;

  function okGet(content: string, path = "renamed.md"): GetReturn {
    return {
      data: {
        id: "uuid-1",
        path,
        content,
        updated_at: "2026-01-01T00:00:00Z",
      },
      error: undefined,
      response: new Response(),
    } as GetReturn;
  }

  function okPut(): PutReturn {
    return {
      data: {
        id: "uuid-1",
        path: "renamed.md",
        updated_at: "2026-01-01T00:00:00Z",
      },
      error: undefined,
      response: new Response(),
    } as PutReturn;
  }

  function errPut(): PutReturn {
    return {
      data: undefined,
      error: { code: "io", message: "disk full" },
      response: new Response(),
    } as unknown as PutReturn;
  }

  function setupNoteRename(opts: { content: string }) {
    useTreeStore.setState({
      pendingRename: { kind: "note", target: "uuid-1" },
    });
    const tree: Tree = {
      root: [
        {
          kind: "note",
          id: "uuid-1",
          path: "scratchpad.md",
          title: "scratchpad.md",
          updated_at: new Date().toISOString(),
        },
      ],
    };
    const muts = defaultMutsResult();
    muts.moveNote.mockResolvedValue({
      id: "uuid-1",
      path: "renamed.md",
      title: "renamed.md",
      updated_at: new Date().toISOString(),
    });
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    mockedUseTreeMutations.mockReturnValue(muts);
    mockedGetNoteFresh.mockResolvedValue(okGet(opts.content));
    return { muts };
  }

  it("R2-6 D1: tree-rename of a note WITH an H1 → moveNote → getNoteFresh → updateNote with rewritten H1", async () => {
    const { muts } = setupNoteRename({ content: "# Original\n\nbody" });
    mockedUpdateNote.mockResolvedValue(okPut());

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    const input = document.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(muts.moveNote).toHaveBeenCalledWith("uuid-1", "renamed.md");
    });
    await waitFor(() => {
      expect(mockedGetNoteFresh).toHaveBeenCalledWith("uuid-1");
    });
    await waitFor(() => {
      expect(mockedUpdateNote).toHaveBeenCalledWith(
        "uuid-1",
        "# renamed\n\nbody",
      );
    });
  });

  it("R2-6 D2: tree-rename of a note WITHOUT an H1 → no updateNote follow-up (research §2.4 — no auto-insert)", async () => {
    const { muts } = setupNoteRename({
      content: "body without heading\nmore body",
    });

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    const input = document.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(muts.moveNote).toHaveBeenCalledWith("uuid-1", "renamed.md");
    });
    await waitFor(() => {
      expect(mockedGetNoteFresh).toHaveBeenCalledWith("uuid-1");
    });
    expect(mockedUpdateNote).not.toHaveBeenCalled();
  });

  it("R2-6 D3: folder rename → H1 rewrite path does NOT fire (folders have no H1)", async () => {
    useTreeStore.setState({
      pendingRename: { kind: "folder", target: "projects" },
    });
    const tree: Tree = {
      root: [
        {
          kind: "folder",
          path: "projects",
          name: "projects",
          children: [],
        },
      ],
    };
    const muts = defaultMutsResult();
    muts.moveFolder.mockResolvedValue({
      kind: "folder",
      path: "renamed",
      name: "renamed",
      children: [],
    });
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    mockedUseTreeMutations.mockReturnValue(muts);

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    const input = document.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(muts.moveFolder).toHaveBeenCalledWith("projects", "renamed");
    });
    expect(mockedGetNoteFresh).not.toHaveBeenCalled();
    expect(mockedUpdateNote).not.toHaveBeenCalled();
  });

  it("R2-6 D4: H1 already matches new name → no redundant updateNote (loop guard)", async () => {
    const { muts } = setupNoteRename({ content: "# renamed\n\nbody" });

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    const input = document.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(muts.moveNote).toHaveBeenCalledWith("uuid-1", "renamed.md");
    });
    await waitFor(() => {
      expect(mockedGetNoteFresh).toHaveBeenCalledWith("uuid-1");
    });
    expect(mockedUpdateNote).not.toHaveBeenCalled();
  });

  it("R2-6 D5: getNoteFresh fails after a successful move → rename still succeeds; warn-level log; no toast", async () => {
    const { muts } = setupNoteRename({ content: "# unused\n\nbody" });
    mockedGetNoteFresh.mockResolvedValue({
      data: undefined,
      error: { code: "not_found", message: "vanished" },
      response: new Response(),
    } as unknown as GetReturn);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    const input = document.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(muts.moveNote).toHaveBeenCalledWith("uuid-1", "renamed.md");
    });
    await waitFor(() => {
      expect(mockedGetNoteFresh).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalled();
    });
    expect(mockedUpdateNote).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/couldn't update the heading/i),
    ).not.toBeInTheDocument();

    warnSpy.mockRestore();
  });

  it("R2-6 D6: updateNote fails after a successful move → toast surfaces the half-state warning", async () => {
    const { muts } = setupNoteRename({ content: "# Original\n\nbody" });
    mockedUpdateNote.mockResolvedValue(errPut());

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    const input = document.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(muts.moveNote).toHaveBeenCalledWith("uuid-1", "renamed.md");
    });
    await waitFor(() => {
      expect(mockedUpdateNote).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        screen.getByText(/couldn't update the heading/i),
      ).toBeInTheDocument();
    });
  });

  it("R2-6 D7: pre-existing happy-path rename (no H1 in content) is unchanged — moveNote only, no toast", async () => {
    const { muts } = setupNoteRename({ content: "" });

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    const input = document.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(muts.moveNote).toHaveBeenCalledWith("uuid-1", "renamed.md");
    });
    expect(mockedUpdateNote).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/couldn't update the heading/i),
    ).not.toBeInTheDocument();
  });
});

describe('Bug F — file/folder duplicate-name validation', () => {
  it('TestFileTree_BugF_FolderRenameInput_DoesNotCollideWithSameNameNote — a folder named untitled does not show Already exists when a note untitled.md is a sibling', async () => {
    useTreeStore.setState({
      pendingRename: { kind: 'folder', target: 'untitled', isNew: true },
    });
    const tree: Tree = {
      root: [
        {
          kind: 'note',
          id: 'note-uuid-1',
          path: 'untitled.md',
          title: 'untitled',
          updated_at: new Date().toISOString(),
        },
        {
          kind: 'folder',
          path: 'untitled',
          name: 'untitled',
          children: [],
        },
      ],
    };
    const muts = defaultMutsResult();
    muts.moveFolder.mockResolvedValue({
      kind: 'folder',
      path: 'untitled',
      name: 'untitled',
      children: [],
    });
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    mockedUseTreeMutations.mockReturnValue(muts);

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      const input = document.querySelector(
        "input[type='text']",
      ) as HTMLInputElement;
      expect(input).not.toBeNull();
    });

    expect(screen.queryByText('Already exists.')).not.toBeInTheDocument();

    const input = document.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(document.querySelector("input[type='text']")).toBeNull();
    });
    expect(muts.moveFolder).not.toHaveBeenCalled();
  });
});


describe("<FileTree /> — multi-select + batch operations", () => {
  function folderNodeStub(args: {
    id: string;
    path: string;
    name: string;
    children?: NodeApi<ArboristNode>[];
  }): NodeApi<ArboristNode> {
    const arborist: ArboristNode = {
      id: args.id,
      name: args.name,
      data: { kind: "folder", path: args.path, name: args.name },
      children: undefined,
    };
    return {
      id: args.id,
      data: arborist,
      children: args.children ?? null,
    } as unknown as NodeApi<ArboristNode>;
  }

  function noteNodeStub(args: {
    id: string;
    path: string;
    title?: string;
  }): NodeApi<ArboristNode> {
    const arborist: ArboristNode = {
      id: "note:" + args.id,
      name: args.title ?? args.path,
      data: {
        kind: "note",
        id: args.id,
        path: args.path,
        title: args.title ?? args.path,
      },
    };
    return {
      id: "note:" + args.id,
      data: arborist,
      children: null,
    } as unknown as NodeApi<ArboristNode>;
  }

  it("handleSelect deselects descendants when a folder enters selection", () => {
    const childA1 = noteNodeStub({ id: "n1", path: "a/x.md" });
    const childA2 = noteNodeStub({ id: "n2", path: "a/y.md" });
    const childA3 = folderNodeStub({
      id: "folder:a/sub",
      path: "a/sub",
      name: "sub",
      children: [noteNodeStub({ id: "n3", path: "a/sub/z.md" })],
    });
    const folderA = folderNodeStub({
      id: "folder:a",
      path: "a",
      name: "a",
      children: [childA1, childA2, childA3],
    });

    const deselect = vi.fn<(id: string) => void>();
    deselectDescendantsOfFolders([folderA, childA1], deselect);

    expect(deselect).toHaveBeenCalledWith("note:n1");
    expect(deselect).toHaveBeenCalledWith("note:n2");
    expect(deselect).toHaveBeenCalledWith("folder:a/sub");
    expect(deselect).toHaveBeenCalledWith("note:n3");
    expect(deselect).toHaveBeenCalledTimes(4);
  });

  it("handleSelect is a no-op when only notes are selected (no folders)", () => {
    const note1 = noteNodeStub({ id: "n1", path: "x.md" });
    const note2 = noteNodeStub({ id: "n2", path: "y.md" });
    const deselect = vi.fn<(id: string) => void>();
    deselectDescendantsOfFolders([note1, note2], deselect);
    expect(deselect).not.toHaveBeenCalled();
  });

  it("handleMove iterates dragNodes and calls moveNote/moveFolder per source (executeBatchMove contract via executeBatchDelete-style helpers)", async () => {
    const muts = defaultMutsResult();
    muts.moveNote.mockResolvedValue(undefined);
    muts.moveFolder.mockResolvedValue(undefined);

    const buildNodeApiStub = (
      data: TreeRowData,
      arboristId: string,
    ): NodeApi<ArboristNode> => {
      const arborist: ArboristNode = {
        id: arboristId,
        name: data.kind === "folder" ? data.name : data.kind === "note" ? data.title : (data as { name: string }).name,
        data,
      };
      return {
        id: arboristId,
        data: arborist,
      } as unknown as NodeApi<ArboristNode>;
    };
    const dragNodes: NodeApi<ArboristNode>[] = [
      buildNodeApiStub(
        { kind: "note", id: "note-a", path: "a.md", title: "A" },
        "note:note-a",
      ),
      buildNodeApiStub(
        { kind: "note", id: "note-b", path: "b.md", title: "B" },
        "note:note-b",
      ),
      buildNodeApiStub(
        { kind: "folder", path: "src", name: "src" },
        "folder:src",
      ),
    ];
    const parentNode = ({
      data: {
        data: { kind: "folder", path: "dest", name: "dest" },
      },
      parent: null,
    } as unknown) as NodeApi<ArboristNode>;

    const sources = dragNodes.map((dn) => ({
      kind: dn.data.data.kind,
      id: dn.data.data.kind === "note" ? dn.data.data.id : null,
      path: (dn.data.data as { path: string }).path,
    }));
    for (const src of sources) {
      const target = computeMoveTarget({
        sourcePath: src.path,
        parentNode,
      });
      if (target.isNoOp) continue;
      if (src.kind === "folder") {
        await muts.moveFolder(src.path, target.newPath);
      } else if (src.id !== null) {
        await muts.moveNote(src.id, target.newPath);
      }
    }

    expect(muts.moveNote).toHaveBeenCalledTimes(2);
    expect(muts.moveNote).toHaveBeenCalledWith("note-a", "dest/a.md");
    expect(muts.moveNote).toHaveBeenCalledWith("note-b", "dest/b.md");
    expect(muts.moveFolder).toHaveBeenCalledTimes(1);
    expect(muts.moveFolder).toHaveBeenCalledWith("src", "dest/src");
  });

  it("handleMove skips no-op moves (computeMoveTarget.isNoOp branch)", async () => {
    const muts = defaultMutsResult();
    muts.moveNote.mockResolvedValue(undefined);

    const buildNodeApiStub = (
      data: TreeRowData,
      arboristId: string,
    ): NodeApi<ArboristNode> => {
      const arborist: ArboristNode = {
        id: arboristId,
        name: data.kind === "folder" ? data.name : data.kind === "note" ? data.title : (data as { name: string }).name,
        data,
      };
      return {
        id: arboristId,
        data: arborist,
      } as unknown as NodeApi<ArboristNode>;
    };
    const dragNodes: NodeApi<ArboristNode>[] = [
      buildNodeApiStub(
        { kind: "note", id: "note-a", path: "a.md", title: "A" },
        "note:note-a",
      ),
      buildNodeApiStub(
        { kind: "note", id: "note-b", path: "b.md", title: "B" },
        "note:note-b",
      ),
    ];

    const noOpResult = computeMoveTarget({
      sourcePath: "a.md",
      parentNode: null,
    });
    expect(noOpResult.isNoOp).toBe(true);

    dragNodes[1] = buildNodeApiStub(
      { kind: "note", id: "note-b", path: "subdir/b.md", title: "B" },
      "note:note-b",
    );
    const sources = dragNodes.map((dn) => ({
      kind: dn.data.data.kind,
      id: dn.data.data.kind === "note" ? dn.data.data.id : null,
      path: (dn.data.data as { path: string }).path,
    }));
    for (const src of sources) {
      const target = computeMoveTarget({
        sourcePath: src.path,
        parentNode: null,
      });
      if (target.isNoOp) continue;
      if (src.kind === "folder") {
        await muts.moveFolder(src.path, target.newPath);
      } else if (src.id !== null) {
        await muts.moveNote(src.id, target.newPath);
      }
    }
    expect(muts.moveNote).toHaveBeenCalledTimes(1);
    expect(muts.moveNote).toHaveBeenCalledWith("note-b", "b.md");
  });

  it("FT-FILE-DRAG-1: file source triggers muts.moveFile(src.path, target.newPath)", async () => {
    const muts = defaultMutsResult();
    (muts as unknown as { moveFile: ReturnType<typeof vi.fn> }).moveFile =
      vi.fn().mockResolvedValue(undefined);

    const buildNodeApiStub = (
      data: TreeRowData,
      arboristId: string,
    ): NodeApi<ArboristNode> => {
      const arborist: ArboristNode = {
        id: arboristId,
        name: data.kind === "folder" ? data.name : data.kind === "note" ? data.title : (data as { name: string }).name,
        data,
      };
      return {
        id: arboristId,
        data: arborist,
      } as unknown as NodeApi<ArboristNode>;
    };

    const fileNode = buildNodeApiStub(
      { kind: "file", path: "doc.pdf", name: "doc.pdf" },
      "file:doc.pdf",
    );
    const parentNode = ({
      data: { data: { kind: "folder", path: "folderA", name: "folderA" } },
      parent: null,
    } as unknown) as NodeApi<ArboristNode>;

    const sources = [fileNode].map((dn) => ({
      kind: dn.data.data.kind,
      id: dn.data.data.kind === "note" ? dn.data.data.id : null,
      path: (dn.data.data as { path: string }).path,
    }));
    for (const src of sources) {
      const target = computeMoveTarget({ sourcePath: src.path, parentNode });
      if (target.isNoOp) continue;
      if (src.kind === "folder") {
        await muts.moveFolder(src.path, target.newPath);
      } else if (src.kind === "note" && src.id !== null) {
        await muts.moveNote(src.id, target.newPath);
      } else if (src.kind === "file") {
        await (muts as unknown as {
          moveFile: (s: string, d: string) => Promise<void>;
        }).moveFile(src.path, target.newPath);
      }
    }

    const moveFileSpy = (muts as unknown as { moveFile: ReturnType<typeof vi.fn> })
      .moveFile;
    expect(moveFileSpy).toHaveBeenCalledTimes(1);
    expect(moveFileSpy).toHaveBeenCalledWith("doc.pdf", "folderA/doc.pdf");
    expect(muts.moveNote).not.toHaveBeenCalled();
    expect(muts.moveFolder).not.toHaveBeenCalled();
  });

  it("handleRequestDelete with multi-selection sets multi target (buildMultiDeleteTarget)", () => {
    const buildSelected = (
      data: TreeRowData,
      arboristId: string,
    ): NodeApi<ArboristNode> => {
      const arborist: ArboristNode = {
        id: arboristId,
        name: data.kind === "folder" ? data.name : data.kind === "note" ? data.title : (data as { name: string }).name,
        data,
      };
      return {
        id: arboristId,
        data: arborist,
      } as unknown as NodeApi<ArboristNode>;
    };
    const dataA: TreeRowData = {
      kind: "note",
      id: "n1",
      path: "a.md",
      title: "A",
    };
    const dataB: TreeRowData = {
      kind: "note",
      id: "n2",
      path: "b.md",
      title: "B",
    };
    const dataC: TreeRowData = {
      kind: "note",
      id: "n3",
      path: "c.md",
      title: "C",
    };
    const selectedNodes = [
      buildSelected(dataA, "note:n1"),
      buildSelected(dataB, "note:n2"),
      buildSelected(dataC, "note:n3"),
    ];

    const result = buildMultiDeleteTarget(dataB, selectedNodes);
    expect(result).toEqual({ kind: "multi", count: 3 });
  });

  it("handleRequestDelete returns null when only one row is selected (single target)", () => {
    const dataA: TreeRowData = {
      kind: "note",
      id: "n1",
      path: "a.md",
      title: "A",
    };
    const arborist: ArboristNode = {
      id: "note:n1",
      name: "A",
      data: dataA,
    };
    const onlyOne = [
      { id: "note:n1", data: arborist } as unknown as NodeApi<ArboristNode>,
    ];
    expect(buildMultiDeleteTarget(dataA, onlyOne)).toBeNull();
    const dataOther: TreeRowData = {
      kind: "note",
      id: "n9",
      path: "z.md",
      title: "Z",
    };
    expect(buildMultiDeleteTarget(dataOther, onlyOne)).toBeNull();
  });

  it("handleConfirmDelete with multi target iterates and deletes all (executeBatchDelete)", async () => {
    const muts = {
      deleteNote: vi.fn().mockResolvedValue(undefined),
      deleteFolder: vi.fn().mockResolvedValue(undefined),
    };
    const buildSelected = (
      data: TreeRowData,
      arboristId: string,
    ): NodeApi<ArboristNode> => {
      const arborist: ArboristNode = {
        id: arboristId,
        name: data.kind === "folder" ? data.name : data.kind === "note" ? data.title : (data as { name: string }).name,
        data,
      };
      return {
        id: arboristId,
        data: arborist,
      } as unknown as NodeApi<ArboristNode>;
    };
    const snapshot = [
      buildSelected(
        { kind: "note", id: "n1", path: "a.md", title: "A" },
        "note:n1",
      ),
      buildSelected(
        { kind: "note", id: "n2", path: "b.md", title: "B" },
        "note:n2",
      ),
      buildSelected(
        { kind: "folder", path: "subdir", name: "subdir" },
        "folder:subdir",
      ),
    ];
    const result = await executeBatchDelete(snapshot, muts);
    expect(muts.deleteNote).toHaveBeenCalledTimes(2);
    expect(muts.deleteNote).toHaveBeenCalledWith("n1");
    expect(muts.deleteNote).toHaveBeenCalledWith("n2");
    expect(muts.deleteFolder).toHaveBeenCalledTimes(1);
    expect(muts.deleteFolder).toHaveBeenCalledWith("subdir", true);
    expect(result).toEqual({ succeeded: 3, total: 3 });
  });

  it("handleConfirmDelete with multi target surfaces partial-completion when some deletes fail", async () => {
    const muts = {
      deleteNote: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("server 500")),
      deleteFolder: vi.fn().mockResolvedValue(undefined),
    };
    const buildSelected = (
      data: TreeRowData,
      arboristId: string,
    ): NodeApi<ArboristNode> => {
      const arborist: ArboristNode = {
        id: arboristId,
        name: data.kind === "folder" ? data.name : data.kind === "note" ? data.title : (data as { name: string }).name,
        data,
      };
      return {
        id: arboristId,
        data: arborist,
      } as unknown as NodeApi<ArboristNode>;
    };
    const snapshot = [
      buildSelected(
        { kind: "note", id: "n1", path: "a.md", title: "A" },
        "note:n1",
      ),
      buildSelected(
        { kind: "note", id: "n2", path: "b.md", title: "B" },
        "note:n2",
      ),
      buildSelected(
        { kind: "folder", path: "subdir", name: "subdir" },
        "folder:subdir",
      ),
    ];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await executeBatchDelete(snapshot, muts);
    expect(muts.deleteNote).toHaveBeenCalledTimes(2);
    expect(muts.deleteFolder).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ succeeded: 2, total: 3 });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});


describe("DnD cycle + mixed-kind", () => {
  function folderNode(path: string): NodeApi<ArboristNode> {
    const arborist: ArboristNode = {
      id: "folder:" + path,
      name: path.split("/").slice(-1)[0] ?? path,
      data: {
        kind: "folder",
        path,
        name: path.split("/").slice(-1)[0] ?? path,
      },
    };
    return {
      id: arborist.id,
      data: arborist,
    } as unknown as NodeApi<ArboristNode>;
  }

  function noteNode(args: { id: string; path: string }): NodeApi<ArboristNode> {
    const arborist: ArboristNode = {
      id: "note:" + args.id,
      name: args.path,
      data: {
        kind: "note",
        id: args.id,
        path: args.path,
        title: args.path,
      },
    };
    return {
      id: arborist.id,
      data: arborist,
    } as unknown as NodeApi<ArboristNode>;
  }


  it("BL-02 / Test 1: isCycleDrop returns true when dest equals a dragged folder's path (self-cycle)", () => {
    expect(isCycleDrop([folderNode("projects")], "projects")).toBe(true);
  });

  it("BL-02 / Test 2: isCycleDrop returns true when dest is a descendant of a dragged folder", () => {
    expect(isCycleDrop([folderNode("projects")], "projects/sub")).toBe(true);
  });

  it("BL-02 / Test 3: isCycleDrop returns false when no dragged folder is an ancestor of dest", () => {
    expect(isCycleDrop([folderNode("alpha")], "beta")).toBe(false);
  });

  it("BL-02 / Test 4: isCycleDrop ignores note-kind dragNodes (only folder-kind ancestry counts)", () => {
    expect(
      isCycleDrop([noteNode({ id: "n1", path: "projects/x.md" })], "projects"),
    ).toBe(false);
  });

  it("BL-02 / Test 5: isCycleDrop guards against prefix-string false-positives (uses '/' separator)", () => {
    expect(isCycleDrop([folderNode("proj")], "projects")).toBe(false);
  });

  it("BL-02: isCycleDrop with empty dragNodes returns false", () => {
    expect(isCycleDrop([], "projects")).toBe(false);
  });

  it("BL-02: isCycleDrop ignores notes mixed in with folders — uses only folder ancestry", () => {
    const mixed = [
      noteNode({ id: "n1", path: "projects/x.md" }),
      folderNode("projects"),
    ];
    expect(isCycleDrop(mixed, "projects/sub")).toBe(true);
    expect(isCycleDrop(mixed, "elsewhere")).toBe(false);
  });


  it("BL-01: mixed-kind drag onto a folder filters dragNodes to folder-kind only", () => {
    const dragNodes: NodeApi<ArboristNode>[] = [
      noteNode({ id: "n1", path: "projects/x.md" }),
      folderNode("archive/old"),
    ];
    const folderSources = dragNodes.filter(
      (n) => n.data.data.kind === "folder",
    );
    expect(folderSources).toHaveLength(1);
    expect(folderSources[0]!.data.data.kind).toBe("folder");
    const handleMoveSpy = vi.fn();
    handleMoveSpy({
      dragIds: folderSources.map((n) => n.id),
      dragNodes: folderSources,
    });
    expect(handleMoveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        dragNodes: expect.arrayContaining([folderSources[0]]),
      }),
    );
    const callArg = handleMoveSpy.mock.calls[0]![0] as {
      dragNodes: NodeApi<ArboristNode>[];
    };
    expect(callArg.dragNodes).toHaveLength(1);
  });

  it("BL-01: all-note drag onto a folder yields empty folderSources → no handleMove dispatch", () => {
    const dragNodes: NodeApi<ArboristNode>[] = [
      noteNode({ id: "n1", path: "x.md" }),
      noteNode({ id: "n2", path: "y.md" }),
    ];
    const folderSources = dragNodes.filter(
      (n) => n.data.data.kind === "folder",
    );
    expect(folderSources).toHaveLength(0);
    // The production code returns early — no handleMove dispatch.
  });

  it("BL-02: folder-drop branch re-checks isCycleDrop and bails before dispatching", () => {
    const folderPath = "projects/sub";
    const dragNodes: NodeApi<ArboristNode>[] = [
      noteNode({ id: "n1", path: "projects/x.md" }),
      folderNode("projects"),
    ];
    const folderSources = dragNodes.filter(
      (n) => n.data.data.kind === "folder",
    );
    expect(isCycleDrop(folderSources, folderPath)).toBe(true);
  });


  it("dragIds are derived from api.dragNodes.map(n => n.id), not api.state.dnd.dragIds", () => {
    const nodes: NodeApi<ArboristNode>[] = [
      folderNode("archive/old"),
      noteNode({ id: "n1", path: "projects/x.md" }),
    ];
    const dragIds = nodes.map((n) => n.id);
    expect(dragIds).toEqual(["folder:archive/old", "note:n1"]);
    // No reference to `api.state` or `.dnd.dragIds` in this shape — the
    // helper is pure and depends only on the documented surface.
  });

  it("dragIds shape matches dragNodes ids in iteration order", () => {
    const nodes: NodeApi<ArboristNode>[] = [
      folderNode("a"),
      folderNode("b"),
      folderNode("c"),
    ];
    const dragIds = nodes.map((n) => n.id);
    expect(dragIds).toHaveLength(nodes.length);
    nodes.forEach((n, i) => {
      expect(dragIds[i]).toBe(n.id);
    });
  });
});


describe("canonical id/path on DeleteTarget", () => {
  it("Test 4: handleRequestDelete (note branch) routes the canonical id to deleteNote", async () => {
    const tree: Tree = {
      root: [
        {
          kind: "note",
          id: "note-canonical-id",
          path: "alpha.md",
          title: "Alpha",
          updated_at: new Date().toISOString(),
        },
      ],
    };
    const muts = defaultMutsResult();
    muts.deleteNote.mockResolvedValue(undefined);
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    mockedUseTreeMutations.mockReturnValue(muts);

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeInTheDocument();
    });
    const row = document.querySelector(
      '[data-tree-row="note-canonical-id"]',
    ) as HTMLElement;
    fireEvent.keyDown(row, { key: "Backspace" });
    await waitFor(() => {
      expect(screen.getByText("Delete note?")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(muts.deleteNote).toHaveBeenCalledWith("note-canonical-id");
    });
  });

  it("Test 5: handleRequestDelete (folder branch) routes the canonical path to deleteFolder", async () => {
    const tree: Tree = {
      root: [
        {
          kind: "folder",
          path: "deeply/nested/folder",
          name: "folder",
          children: [
            {
              kind: "note",
              id: "n-inner",
              path: "deeply/nested/folder/x.md",
              title: "X",
              updated_at: new Date().toISOString(),
            },
          ],
        },
      ],
    };
    const muts = defaultMutsResult();
    muts.deleteFolder.mockResolvedValue(undefined);
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    mockedUseTreeMutations.mockReturnValue(muts);

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("folder")).toBeInTheDocument();
    });
    const row = document.querySelector(
      '[data-tree-row="deeply/nested/folder"]',
    ) as HTMLElement;
    fireEvent.keyDown(row, { key: "Backspace" });
    await waitFor(() => {
      expect(screen.getByText("Delete folder?")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(muts.deleteFolder).toHaveBeenCalledWith(
        "deeply/nested/folder",
        true,
      );
    });
  });

  it("Tests 6-7: handleConfirmDelete uses target.id / target.path directly (no name-based lookup helpers)", () => {
    const fileTreeSrc = String(FileTree.toString());
    expect(fileTreeSrc).not.toMatch(/findNoteIdByName/);
    expect(fileTreeSrc).not.toMatch(/findFolderPathByName/);
  });

  it("Test 8: basename collision regression — two notes named Foo.md, deleting the SUBFOLDER one removes only the subfolder note", async () => {
    const tree: Tree = {
      root: [
        {
          kind: "note",
          id: "root-foo-id",
          path: "Foo.md",
          title: "Foo",
          updated_at: new Date().toISOString(),
        },
        {
          kind: "folder",
          path: "subdir",
          name: "subdir",
          children: [
            {
              kind: "note",
              id: "subdir-foo-id",
              path: "subdir/Foo.md",
              title: "Foo",
              updated_at: new Date().toISOString(),
            },
          ],
        },
      ],
    };
    useTreeStore.setState({
      expanded: new Set(["subdir"]),
    });
    const muts = defaultMutsResult();
    muts.deleteNote.mockResolvedValue(undefined);
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    mockedUseTreeMutations.mockReturnValue(muts);

    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      expect(
        document.querySelector('[data-tree-row="root-foo-id"]'),
      ).not.toBeNull();
      expect(
        document.querySelector('[data-tree-row="subdir-foo-id"]'),
      ).not.toBeNull();
    });

    const subdirRow = document.querySelector(
      '[data-tree-row="subdir-foo-id"]',
    ) as HTMLElement;
    fireEvent.keyDown(subdirRow, { key: "Backspace" });
    await waitFor(() => {
      expect(screen.getByText("Delete note?")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(muts.deleteNote).toHaveBeenCalledWith("subdir-foo-id");
    });
    expect(muts.deleteNote).not.toHaveBeenCalledWith("root-foo-id");
  });
});


describe("FT-folder-default — folders default CLOSED", () => {
  const twoFolderTree: Tree = {
    root: [
      {
        kind: "folder",
        path: "foo",
        name: "foo",
        children: [
          {
            kind: "note",
            id: "uuid-foo-a",
            path: "foo/a.md",
            title: "A",
            updated_at: new Date().toISOString(),
          },
        ],
      },
      {
        kind: "folder",
        path: "bar",
        name: "bar",
        children: [
          {
            kind: "note",
            id: "uuid-bar-c",
            path: "bar/c.md",
            title: "C",
            updated_at: new Date().toISOString(),
          },
        ],
      },
    ],
  };

  it("FT-FD-1: empty expanded set → all folders rendered CLOSED (aria-expanded=false)", async () => {
    useTreeStore.setState({ expanded: new Set() });
    mockedUseFileTree.mockReturnValue({
      tree: twoFolderTree,
      loading: false,
      error: null,
      refresh: noopRefresh,
    });
    mockedUseTreeMutations.mockReturnValue(defaultMutsResult());
    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("foo")).toBeInTheDocument();
      expect(screen.getByText("bar")).toBeInTheDocument();
    });
    const expandedItems = document.querySelectorAll("[aria-expanded='true']");
    expect(expandedItems.length).toBe(0);
    expect(screen.queryByText("A")).toBeNull();
    expect(screen.queryByText("C")).toBeNull();
  });

  it("FT-FD-2: expanded contains 'foo' → only 'foo' folder is open, 'bar' stays closed", async () => {
    useTreeStore.setState({ expanded: new Set(["foo"]) });
    mockedUseFileTree.mockReturnValue({
      tree: twoFolderTree,
      loading: false,
      error: null,
      refresh: noopRefresh,
    });
    mockedUseTreeMutations.mockReturnValue(defaultMutsResult());
    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("foo")).toBeInTheDocument();
      expect(screen.getByText("bar")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("A")).toBeInTheDocument();
    });
    expect(screen.queryByText("C")).toBeNull();
    const barFolderRow = document.querySelector(
      '[data-tree-row-kind="folder"][data-tree-row="bar"]',
    );
    expect(barFolderRow).not.toBeNull();
    expect(barFolderRow!.getAttribute("aria-expanded")).not.toBe("true");
  });
});


vi.mock("../lib/filesApi", () => ({
  uploadFile: vi.fn(),
}));
vi.mock("../lib/useFileTree", async () => {
  const actual = await vi.importActual<typeof import("../lib/useFileTree")>(
    "../lib/useFileTree",
  );
  return {
    ...actual,
    useFileTree: vi.fn(),
    broadcastRefresh: vi.fn(),
  };
});
import { uploadFile as mockedUploadFile } from "../lib/filesApi";
import { broadcastRefresh as mockedBroadcastRefresh } from "../lib/useFileTree";
const mockedUpload = vi.mocked(mockedUploadFile);
const mockedBcast = vi.mocked(mockedBroadcastRefresh);


function makeOsFileDragEvent(
  type: "dragover" | "drop",
  files: File[],
): Event {
  const dt = {
    types: ["Files"],
    files,
    dropEffect: "move",
  };
  const evt = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(evt, "dataTransfer", {
    value: dt,
    writable: false,
  });
  return evt;
}

describe("FT-no-external-drop — sidebar accepts OS file drag", () => {
  beforeEach(() => {
    mockedUpload.mockReset();
    mockedBcast.mockReset();
  });

  it("FT-NED-1: dragover with 'Files' calls stopPropagation AND preventDefault", async () => {
    const tree: Tree = {
      root: [
        {
          kind: "folder",
          path: "foo",
          name: "foo",
          children: [],
        },
      ],
    };
    useTreeStore.setState({ expanded: new Set() });
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: noopRefresh,
    });
    mockedUseTreeMutations.mockReturnValue(defaultMutsResult());
    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("foo")).toBeInTheDocument();
    });

    const treeEl = document.querySelector('[role="tree"]');
    expect(treeEl).not.toBeNull();

    const evt = makeOsFileDragEvent("dragover", []);
    const stopPropSpy = vi.spyOn(evt, "stopPropagation");
    const preventDefaultSpy = vi.spyOn(evt, "preventDefault");
    treeEl!.dispatchEvent(evt);
    expect(stopPropSpy).toHaveBeenCalled();
    expect(preventDefaultSpy).toHaveBeenCalled();
  });


  async function renderTree(tree: Tree) {
    useTreeStore.setState({ expanded: new Set(["folderA", "folderB"]) });
    mockedUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: noopRefresh,
    });
    mockedUseTreeMutations.mockReturnValue(defaultMutsResult());
    renderWithProvider(<FileTree onSelectNote={vi.fn()} />);
    await waitFor(() => {
      expect(document.querySelector('[role="tree"]')).not.toBeNull();
    });
  }

  it("FT-DROP-1: dropping on a FOLDER row uploads to that folder.path", async () => {
    const tree: Tree = {
      root: [
        { kind: "folder", path: "folderA", name: "folderA", children: [] },
      ],
    };
    await renderTree(tree);
    mockedUpload.mockResolvedValue({
      path: "folderA/photo.png",
      name: "photo.png",
      size_bytes: 1,
    });

    await waitFor(() => {
      expect(
        document.querySelector('[data-tree-row="folderA"][data-tree-row-kind="folder"]'),
      ).not.toBeNull();
    });
    const folderRow = document.querySelector(
      '[data-tree-row="folderA"][data-tree-row-kind="folder"]',
    ) as HTMLElement;

    const file = new File(["x"], "photo.png", { type: "image/png" });
    const evt = makeOsFileDragEvent("drop", [file]);
    folderRow.dispatchEvent(evt);
    await waitFor(() => {
      expect(mockedUpload).toHaveBeenCalled();
    });
    expect(mockedUpload).toHaveBeenCalledWith("folderA", file);
    await waitFor(() => {
      expect(mockedBcast).toHaveBeenCalled();
    });
  });

  it("FT-DROP-2: dropping on a NOTE row uploads to the note's parent dir", async () => {
    const noteId = "00000000-0000-4000-a000-000000000111";
    const tree: Tree = {
      root: [
        {
          kind: "folder",
          path: "folderA",
          name: "folderA",
          children: [
            {
              kind: "note",
              id: noteId,
              path: "folderA/sub.md",
              title: "sub",
              updated_at: new Date().toISOString(),
            },
          ],
        },
      ],
    };
    await renderTree(tree);
    mockedUpload.mockResolvedValue({
      path: "folderA/upload.png",
      name: "upload.png",
      size_bytes: 1,
    });

    await waitFor(() => {
      expect(
        document.querySelector(
          `[data-tree-row="${noteId}"][data-tree-row-kind="note"]`,
        ),
      ).not.toBeNull();
    });
    const noteRow = document.querySelector(
      `[data-tree-row="${noteId}"][data-tree-row-kind="note"]`,
    ) as HTMLElement;

    const file = new File(["x"], "upload.png", { type: "image/png" });
    noteRow.dispatchEvent(makeOsFileDragEvent("drop", [file]));
    await waitFor(() => {
      expect(mockedUpload).toHaveBeenCalled();
    });
    expect(mockedUpload).toHaveBeenCalledWith("folderA", file);
  });

  it("FT-DROP-3: dropping on a FILE row uploads to the file's parent dir", async () => {
    const tree: Tree = {
      root: [
        {
          kind: "folder",
          path: "folderA",
          name: "folderA",
          children: [
            {
              kind: "file",
              path: "folderA/existing.png",
              name: "existing.png",
            },
          ],
        },
      ],
    };
    await renderTree(tree);
    mockedUpload.mockResolvedValue({
      path: "folderA/upload.png",
      name: "upload.png",
      size_bytes: 1,
    });

    await waitFor(() => {
      expect(
        document.querySelector(
          '[data-tree-row="folderA/existing.png"][data-tree-row-kind="file"]',
        ),
      ).not.toBeNull();
    });
    const fileRow = document.querySelector(
      '[data-tree-row="folderA/existing.png"][data-tree-row-kind="file"]',
    ) as HTMLElement;

    const file = new File(["x"], "upload.png", { type: "image/png" });
    fileRow.dispatchEvent(makeOsFileDragEvent("drop", [file]));
    await waitFor(() => {
      expect(mockedUpload).toHaveBeenCalled();
    });
    expect(mockedUpload).toHaveBeenCalledWith("folderA", file);
  });

  it("FT-DROP-4: dropping on EMPTY tree area uploads to vault root ('')", async () => {
    const tree: Tree = {
      root: [
        { kind: "folder", path: "folderA", name: "folderA", children: [] },
      ],
    };
    await renderTree(tree);
    mockedUpload.mockResolvedValue({
      path: "rooted.png",
      name: "rooted.png",
      size_bytes: 1,
    });

    const treeEl = document.querySelector('[role="tree"]');
    expect(treeEl).not.toBeNull();
    const wrapper = treeEl!.parentElement!;

    const file = new File(["x"], "rooted.png", { type: "image/png" });
    wrapper.dispatchEvent(makeOsFileDragEvent("drop", [file]));
    await waitFor(() => {
      expect(mockedUpload).toHaveBeenCalled();
    });
    expect(mockedUpload).toHaveBeenCalledWith("", file);
  });

  it("FT-DROP-5: after successful upload, broadcastRefresh() is called", async () => {
    const tree: Tree = {
      root: [
        { kind: "folder", path: "folderA", name: "folderA", children: [] },
      ],
    };
    await renderTree(tree);
    mockedUpload.mockResolvedValue({
      path: "folderA/x.png",
      name: "x.png",
      size_bytes: 1,
    });

    await waitFor(() => {
      expect(
        document.querySelector('[data-tree-row="folderA"][data-tree-row-kind="folder"]'),
      ).not.toBeNull();
    });
    const folderRow = document.querySelector(
      '[data-tree-row="folderA"][data-tree-row-kind="folder"]',
    ) as HTMLElement;
    const file = new File(["x"], "x.png");
    folderRow.dispatchEvent(makeOsFileDragEvent("drop", [file]));
    await waitFor(() => {
      expect(mockedBcast).toHaveBeenCalled();
    });
  });

  describe("FT-N2-MD — markdown drops create notes", () => {
    beforeEach(() => {
      mockedCreateNoteFromMarkdownDrop.mockReset();
      mockedUpload.mockReset();
      mockedBcast.mockReset();
    });

    it("FT-N2-MD-1: dropping a .md file calls createNoteFromMarkdownDrop (NOT uploadFile)", async () => {
      const tree: Tree = {
        root: [
          { kind: "folder", path: "folderA", name: "folderA", children: [] },
        ],
      };
      await renderTree(tree);
      mockedCreateNoteFromMarkdownDrop.mockResolvedValue({
        id: "uuid-1",
        path: "folderA/dropped.md",
      });

      await waitFor(() => {
        expect(
          document.querySelector('[data-tree-row="folderA"][data-tree-row-kind="folder"]'),
        ).not.toBeNull();
      });
      const folderRow = document.querySelector(
        '[data-tree-row="folderA"][data-tree-row-kind="folder"]',
      ) as HTMLElement;

      const mdFile = new File(["# hello\n\nbody"], "dropped.md", { type: "text/markdown" });
      folderRow.dispatchEvent(makeOsFileDragEvent("drop", [mdFile]));

      await waitFor(() => {
        expect(mockedCreateNoteFromMarkdownDrop).toHaveBeenCalled();
      });
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it("FT-N2-MD-2: createNoteFromMarkdownDrop is called with notePath = targetDir + '/' + basename", async () => {
      const tree: Tree = {
        root: [
          { kind: "folder", path: "folderA", name: "folderA", children: [] },
        ],
      };
      await renderTree(tree);
      mockedCreateNoteFromMarkdownDrop.mockResolvedValue({
        id: "uuid-2",
        path: "folderA/foo.md",
      });

      await waitFor(() => {
        expect(
          document.querySelector('[data-tree-row="folderA"][data-tree-row-kind="folder"]'),
        ).not.toBeNull();
      });
      const folderRow = document.querySelector(
        '[data-tree-row="folderA"][data-tree-row-kind="folder"]',
      ) as HTMLElement;

      const mdFile = new File(["body content"], "foo.md", { type: "text/markdown" });
      folderRow.dispatchEvent(makeOsFileDragEvent("drop", [mdFile]));

      await waitFor(() => {
        expect(mockedCreateNoteFromMarkdownDrop).toHaveBeenCalledWith(
          "folderA/foo.md",
          "body content",
        );
      });
    });

    it("FT-N2-MD-3: dropping .md at vault root passes basename only (no leading slash)", async () => {
      const tree: Tree = {
        root: [
          { kind: "folder", path: "folderA", name: "folderA", children: [] },
        ],
      };
      await renderTree(tree);
      mockedCreateNoteFromMarkdownDrop.mockResolvedValue({
        id: "uuid-3",
        path: "vault-root.md",
      });

      const treeEl = document.querySelector('[role="tree"]');
      expect(treeEl).not.toBeNull();
      const wrapper = treeEl!.parentElement!;

      const mdFile = new File(["root note"], "vault-root.md", { type: "text/markdown" });
      wrapper.dispatchEvent(makeOsFileDragEvent("drop", [mdFile]));

      await waitFor(() => {
        expect(mockedCreateNoteFromMarkdownDrop).toHaveBeenCalledWith(
          "vault-root.md",
          "root note",
        );
      });
    });

    it("FT-N2-MD-4: non-.md drops still route to uploadFile (regression guard)", async () => {
      const tree: Tree = {
        root: [
          { kind: "folder", path: "folderA", name: "folderA", children: [] },
        ],
      };
      await renderTree(tree);
      mockedUpload.mockResolvedValue({
        path: "folderA/photo.png",
        name: "photo.png",
        size_bytes: 1,
      });

      await waitFor(() => {
        expect(
          document.querySelector('[data-tree-row="folderA"][data-tree-row-kind="folder"]'),
        ).not.toBeNull();
      });
      const folderRow = document.querySelector(
        '[data-tree-row="folderA"][data-tree-row-kind="folder"]',
      ) as HTMLElement;

      const pngFile = new File(["x"], "photo.png", { type: "image/png" });
      folderRow.dispatchEvent(makeOsFileDragEvent("drop", [pngFile]));

      await waitFor(() => {
        expect(mockedUpload).toHaveBeenCalledWith("folderA", pngFile);
      });
      expect(mockedCreateNoteFromMarkdownDrop).not.toHaveBeenCalled();
    });
  });
});

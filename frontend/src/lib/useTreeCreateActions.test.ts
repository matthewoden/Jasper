/**
 * Tests for useTreeCreateActions — the shared create-note / create-folder
 * handlers consumed by Sidebar's toolbar and FileTree's context-menu /
 * kebab callbacks.
 *
 * Coverage focuses on the Gap 5 fix: the hook now reads the live tree
 * state and passes the lowest non-colliding name to muts.createNote /
 * muts.createFolder instead of a literal "untitled".
 *
 * useFileTree and useTreeMutations are mocked — the unit under test is
 * the wiring between those two hooks and the nextUntitledName helper.
 * useToast is real (we wrap with <ToastProvider>) so error-path tests
 * could be added later without restructuring.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";

import type { Tree } from "./treeApi";
import { ToastProvider } from "../components/Toast";

vi.mock("./useFileTree", () => ({
  useFileTree: vi.fn(),
}));

vi.mock("./useTreeMutations", async () => {
  const actual = await vi.importActual<
    typeof import("./useTreeMutations")
  >("./useTreeMutations");
  return {
    ...actual,
    useTreeMutations: vi.fn(),
  };
});

import { useFileTree } from "./useFileTree";
import { useTreeMutations } from "./useTreeMutations";
import { useTreeCreateActions } from "./useTreeCreateActions";

const mockedUseFileTree = vi.mocked(useFileTree);
const mockedUseTreeMutations = vi.mocked(useTreeMutations);

function defaultMutsResult() {
  return {
    createNote: vi.fn(),
    deleteNote: vi.fn(),
    moveNote: vi.fn(),
    createFolder: vi.fn(),
    deleteFolder: vi.fn(),
    moveFolder: vi.fn(),
  };
}

function setUseFileTree(tree: Tree | null) {
  mockedUseFileTree.mockReturnValue({
    tree,
    loading: false,
    error: null,
    refresh: () => Promise.resolve(),
    mutate: () => {},
  });
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ToastProvider, null, children);

describe("useTreeCreateActions — auto-increment default name (Gap 5)", () => {
  let muts: ReturnType<typeof defaultMutsResult>;

  beforeEach(() => {
    muts = defaultMutsResult();
    mockedUseTreeMutations.mockReturnValue(muts);
  });

  afterEach(() => {
    mockedUseFileTree.mockReset();
    mockedUseTreeMutations.mockReset();
  });

  it("createNoteAt at root with one untitled.md picks 'untitled 1'", async () => {
    setUseFileTree({
      root: [
        {
          kind: "note",
          id: "n1",
          path: "untitled.md",
          title: "untitled",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    muts.createNote.mockResolvedValue({
      id: "n2",
      path: "untitled 1.md",
      title: "untitled 1",
      updated_at: "2026-01-01T00:00:00Z",
    });

    const { result } = renderHook(() => useTreeCreateActions(), { wrapper });
    await result.current.createNoteAt("");

    expect(muts.createNote).toHaveBeenCalledTimes(1);
    expect(muts.createNote).toHaveBeenCalledWith("", "untitled 1");
  });

  it("createFolderAt at root with one untitled folder picks 'untitled 1'", async () => {
    setUseFileTree({
      root: [
        {
          kind: "folder",
          path: "untitled",
          name: "untitled",
        },
      ],
    });
    muts.createFolder.mockResolvedValue({
      kind: "folder",
      path: "untitled 1",
      name: "untitled 1",
    });

    const { result } = renderHook(() => useTreeCreateActions(), { wrapper });
    await result.current.createFolderAt("");

    expect(muts.createFolder).toHaveBeenCalledTimes(1);
    expect(muts.createFolder).toHaveBeenCalledWith("", "untitled 1");
  });

  it("createNoteAt at empty root picks 'untitled' (no collision)", async () => {
    setUseFileTree({ root: [] });
    muts.createNote.mockResolvedValue({
      id: "n1",
      path: "untitled.md",
      title: "untitled",
      updated_at: "2026-01-01T00:00:00Z",
    });

    const { result } = renderHook(() => useTreeCreateActions(), { wrapper });
    await result.current.createNoteAt("");

    expect(muts.createNote).toHaveBeenCalledTimes(1);
    expect(muts.createNote).toHaveBeenCalledWith("", "untitled");
  });

  it("createNoteAt inside a nested folder uses ONLY that folder's siblings", async () => {
    // The root contains an untitled.md note AND a `projects` folder
    // that itself contains an untitled.md. The root-level note must
    // NOT count as a sibling when creating inside `projects` — the
    // result must be `untitled 1` (because of the in-folder collision)
    // not `untitled 2` (which would happen if we mistakenly mixed the
    // root and folder siblings).
    setUseFileTree({
      root: [
        {
          kind: "note",
          id: "root-untitled",
          path: "untitled.md",
          title: "untitled",
          updated_at: "2026-01-01T00:00:00Z",
        },
        {
          kind: "folder",
          path: "projects",
          name: "projects",
          children: [
            {
              kind: "note",
              id: "proj-untitled",
              path: "projects/untitled.md",
              title: "untitled",
              updated_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      ],
    });
    muts.createNote.mockResolvedValue({
      id: "n3",
      path: "projects/untitled 1.md",
      title: "untitled 1",
      updated_at: "2026-01-01T00:00:00Z",
    });

    const { result } = renderHook(() => useTreeCreateActions(), { wrapper });
    await result.current.createNoteAt("projects");

    expect(muts.createNote).toHaveBeenCalledTimes(1);
    expect(muts.createNote).toHaveBeenCalledWith("projects", "untitled 1");
  });
});

/**
 * Gap R2-2 — in-flight guard.
 *
 * Per `03-RESEARCH-ROUND2.md` §3.2 the auto-increment helper is correct; the
 * bug is a race condition. Rapid double-clicks of New Folder fire two
 * createFolderAt calls in the same React tick, both reading the pre-create
 * snapshot of `tree`, both computing `"untitled"`, and the second 409s.
 *
 * Fix: a useState boolean `isCreating` guards both create paths and is
 * surfaced on the hook return so SidebarToolbar can disable its New Note +
 * New Folder buttons mirroring the Refresh button's spin-disabled pattern.
 */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useTreeCreateActions — in-flight guard (Gap R2-2)", () => {
  let muts: ReturnType<typeof defaultMutsResult>;

  beforeEach(() => {
    muts = defaultMutsResult();
    mockedUseTreeMutations.mockReturnValue(muts);
    setUseFileTree({ root: [] });
  });

  afterEach(() => {
    mockedUseFileTree.mockReset();
    mockedUseTreeMutations.mockReset();
  });

  it("isCreating is false on initial render", () => {
    const { result } = renderHook(() => useTreeCreateActions(), { wrapper });
    expect(result.current.isCreating).toBe(false);
  });

  it("isCreating flips true while createNoteAt is in flight, false after resolve", async () => {
    const d = deferred<{
      id: string;
      path: string;
      title: string;
      updated_at: string;
    }>();
    muts.createNote.mockReturnValue(d.promise);

    const { result } = renderHook(() => useTreeCreateActions(), { wrapper });
    expect(result.current.isCreating).toBe(false);

    let pending: Promise<void>;
    act(() => {
      pending = result.current.createNoteAt("");
    });

    await waitFor(() => {
      expect(result.current.isCreating).toBe(true);
    });

    await act(async () => {
      d.resolve({
        id: "n1",
        path: "untitled.md",
        title: "untitled",
        updated_at: "2026-01-01T00:00:00Z",
      });
      await pending!;
    });

    await waitFor(() => {
      expect(result.current.isCreating).toBe(false);
    });
  });

  it("createFolderAt during in-flight createNoteAt is a no-op (zero mutator calls)", async () => {
    const d = deferred<{
      id: string;
      path: string;
      title: string;
      updated_at: string;
    }>();
    muts.createNote.mockReturnValue(d.promise);

    const { result } = renderHook(() => useTreeCreateActions(), { wrapper });

    let firstPending: Promise<void>;
    act(() => {
      firstPending = result.current.createNoteAt("");
    });

    // Wait until the in-flight flag has flipped — proves the first call has
    // committed to the guard before we attempt the second.
    await waitFor(() => {
      expect(result.current.isCreating).toBe(true);
    });

    // Second call MUST early-return without invoking createFolder.
    await act(async () => {
      await result.current.createFolderAt("");
    });
    expect(muts.createFolder).not.toHaveBeenCalled();

    // Clean up: resolve the first call so the hook settles.
    await act(async () => {
      d.resolve({
        id: "n1",
        path: "untitled.md",
        title: "untitled",
        updated_at: "2026-01-01T00:00:00Z",
      });
      await firstPending!;
    });
  });

  it("isCreating returns to false when the mutator throws", async () => {
    muts.createNote.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useTreeCreateActions(), { wrapper });

    await act(async () => {
      await result.current.createNoteAt("");
    });

    expect(result.current.isCreating).toBe(false);
  });

  it("a second createNoteAt call after the first resolves succeeds (guard is per-flight)", async () => {
    muts.createNote.mockResolvedValue({
      id: "n1",
      path: "untitled.md",
      title: "untitled",
      updated_at: "2026-01-01T00:00:00Z",
    });

    const { result } = renderHook(() => useTreeCreateActions(), { wrapper });

    await act(async () => {
      await result.current.createNoteAt("");
    });
    await act(async () => {
      await result.current.createNoteAt("");
    });

    expect(muts.createNote).toHaveBeenCalledTimes(2);
  });
});

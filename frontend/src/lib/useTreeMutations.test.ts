/**
 * Tests for useTreeMutations — typed mutation hooks.
 *
 * Each hook wraps a treeApi.* call and either returns the typed payload on
 * success or throws a TreeMutationError carrying { code, message, status }
 * so callers can branch and surface destructive toasts.
 *
 * treeApi is mocked to synthesize success / error responses without network calls.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postNotesMock = vi.fn();
const deleteNoteByIdMock = vi.fn();
const postNoteMoveMock = vi.fn();
const postFoldersMock = vi.fn();
const deleteFolderMock = vi.fn();
const postFolderMoveMock = vi.fn();
const getTreeMock = vi.fn();

const filesApiMoveFileMock = vi.fn();

// treeResource is rebuilt fresh here with the REAL createResource (mirrors
// plan 07's useBacklinks.test.ts pattern) so useFileTree()'s auto-refresh
// contract (broadcastRefresh -> treeResource.invalidate()) is exercised for
// real — getTreeMock stays a separate mock since useTreeMutations.ts's own
// moveFile() 404-reconciliation path calls treeApi.getTree() directly,
// imperatively, outside the resource cache.
vi.mock("./treeApi", async () => {
  const { createResource } = await import("./resources/createResource");
  return {
    getTree: (...args: unknown[]) => getTreeMock(...args),
    postNotes: (...args: unknown[]) => postNotesMock(...args),
    deleteNoteById: (...args: unknown[]) => deleteNoteByIdMock(...args),
    postNoteMove: (...args: unknown[]) => postNoteMoveMock(...args),
    postFolders: (...args: unknown[]) => postFoldersMock(...args),
    deleteFolder: (...args: unknown[]) => deleteFolderMock(...args),
    postFolderMove: (...args: unknown[]) => postFolderMoveMock(...args),
    treeResource: createResource("tree", (...args: unknown[]) => getTreeMock(...args), {
      mode: "cached",
      invalidatedBy: [
        "note:created", "note:deleted", "note:moved",
        "folder:created", "folder:deleted", "folder:moved",
        "file:created", "file:deleted", "file:moved",
        "links:rewritten", "reindex:complete",
      ],
    }),
  };
});

vi.mock("./filesApi", () => ({
  moveFile: (...args: unknown[]) => filesApiMoveFileMock(...args),
}));

import { TreeMutationError, useTreeMutations } from "./useTreeMutations";
import { useFileTree } from "./useFileTree";
import { treeResource } from "./treeApi";

describe("useTreeMutations", () => {
  beforeEach(() => {
    postNotesMock.mockReset();
    deleteNoteByIdMock.mockReset();
    postNoteMoveMock.mockReset();
    postFoldersMock.mockReset();
    deleteFolderMock.mockReset();
    postFolderMoveMock.mockReset();
    getTreeMock.mockReset();
    filesApiMoveFileMock.mockReset();
    getTreeMock.mockResolvedValue({ data: { root: [] } });
  });

  it("TestCreateNote_HappyPath: returns NoteSummary on 201", async () => {
    const summary = {
      id: "uuid-1",
      path: "projects/scratch.md",
      title: "scratch",
      updated_at: "2026-01-01T00:00:00Z",
    };
    postNotesMock.mockResolvedValue({ data: summary });

    const { result } = renderHook(() => useTreeMutations());
    const got = await result.current.createNote("projects", "scratch");

    expect(got).toEqual(summary);
    expect(postNotesMock).toHaveBeenCalledWith({
      parent_path: "projects",
      title: "scratch",
    });
  });

  it("TestCreateNote_409_ThrowsTreeMutationError: case_collision propagates with code/status", async () => {
    postNotesMock.mockResolvedValue({
      error: { code: "case_collision", message: "already exists", status: 409 },
    });

    const { result } = renderHook(() => useTreeMutations());

    await expect(result.current.createNote("", "Scratchpad")).rejects.toThrow(
      TreeMutationError,
    );

    try {
      await result.current.createNote("", "Scratchpad");
    } catch (e) {
      const err = e as TreeMutationError;
      expect(err.code).toBe("case_collision");
      expect(err.status).toBe(409);
      expect(err.message).toBe("already exists");
    }
  });

  it("TestDeleteNote_HappyPath: resolves with no return value on 204", async () => {
    deleteNoteByIdMock.mockResolvedValue({});
    const { result } = renderHook(() => useTreeMutations());
    await expect(result.current.deleteNote("uuid-1")).resolves.toBeUndefined();
    expect(deleteNoteByIdMock).toHaveBeenCalledWith("uuid-1");
  });

  it("TestDeleteNote_404: throws TreeMutationError with code=not_found, status=404", async () => {
    deleteNoteByIdMock.mockResolvedValue({
      error: { code: "not_found", message: "no note", status: 404 },
    });
    const { result } = renderHook(() => useTreeMutations());

    try {
      await result.current.deleteNote("missing");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as TreeMutationError;
      expect(err).toBeInstanceOf(TreeMutationError);
      expect(err.code).toBe("not_found");
      expect(err.status).toBe(404);
    }
  });

  it("TestMoveNote_HappyPath: returns post-move NoteSummary", async () => {
    const moved = {
      id: "uuid-1",
      path: "ideas/scratch.md",
      title: "scratch",
      updated_at: "2026-01-01T00:00:00Z",
    };
    postNoteMoveMock.mockResolvedValue({ data: moved });
    const { result } = renderHook(() => useTreeMutations());

    const got = await result.current.moveNote("uuid-1", "ideas/scratch.md");
    expect(got).toEqual(moved);
    expect(postNoteMoveMock).toHaveBeenCalledWith("uuid-1", "ideas/scratch.md");
  });

  it("TestCreateFolder_HappyPath: returns FolderNode on 201", async () => {
    postFoldersMock.mockResolvedValue({
      data: { kind: "folder", path: "ideas", name: "ideas" },
    });
    const { result } = renderHook(() => useTreeMutations());
    const got = await result.current.createFolder("", "ideas");
    expect(got).toEqual({ kind: "folder", path: "ideas", name: "ideas" });
    expect(postFoldersMock).toHaveBeenCalledWith({
      parent_path: "",
      name: "ideas",
    });
  });

  it("TestCreateFolder_400_TitleWithSlash: invalid_request throws", async () => {
    postFoldersMock.mockResolvedValue({
      error: { code: "invalid_request", message: "bad name", status: 400 },
    });
    const { result } = renderHook(() => useTreeMutations());
    await expect(result.current.createFolder("", "bad/name")).rejects.toThrow(
      TreeMutationError,
    );
  });

  it("TestDeleteFolder_HappyPath: resolves with no return value when recursive", async () => {
    deleteFolderMock.mockResolvedValue({});
    const { result } = renderHook(() => useTreeMutations());
    await expect(
      result.current.deleteFolder("projects/old", true),
    ).resolves.toBeUndefined();
    expect(deleteFolderMock).toHaveBeenCalledWith("projects/old", true);
  });

  it("TestDeleteFolder_409_NotEmpty: folder_not_empty throws with status=409", async () => {
    deleteFolderMock.mockResolvedValue({
      error: { code: "folder_not_empty", message: "has children", status: 409 },
    });
    const { result } = renderHook(() => useTreeMutations());

    try {
      await result.current.deleteFolder("projects", false);
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as TreeMutationError;
      expect(err.code).toBe("folder_not_empty");
      expect(err.status).toBe(409);
    }
  });

  it("TestMoveFolder_HappyPath: returns FolderNode on 200", async () => {
    postFolderMoveMock.mockResolvedValue({
      data: { kind: "folder", path: "projects/new", name: "new" },
    });
    const { result } = renderHook(() => useTreeMutations());
    const got = await result.current.moveFolder("projects/old", "projects/new");
    expect(got).toEqual({ kind: "folder", path: "projects/new", name: "new" });
    expect(postFolderMoveMock).toHaveBeenCalledWith(
      "projects/old",
      "projects/new",
    );
  });
});


describe("auto-refresh contract (Gap 1)", () => {
  beforeEach(() => {
    postNotesMock.mockReset();
    deleteNoteByIdMock.mockReset();
    postNoteMoveMock.mockReset();
    postFoldersMock.mockReset();
    deleteFolderMock.mockReset();
    postFolderMoveMock.mockReset();
    getTreeMock.mockReset();
    filesApiMoveFileMock.mockReset();
    // treeResource is a module-level "cached" singleton — clear between
    // tests so each harness() mount issues its own fresh fetch instead of
    // reading a previous test's hydrated cache.
    treeResource.clear();
    getTreeMock.mockResolvedValue({ data: { root: [] } });
  });

  afterEach(() => {
    cleanup();
  });

  function harness() {
    return renderHook(() => ({
      tree: useFileTree(),
      muts: useTreeMutations(),
    }));
  }

  it("createNote refreshes useFileTree after success", async () => {
    postNotesMock.mockResolvedValue({
      data: {
        id: "n1",
        path: "untitled.md",
        title: "untitled",
        updated_at: "2026-01-01T00:00:00Z",
      },
    });

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.muts.createNote("", "untitled");
    });

    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(2));
  });

  it("createNote does NOT refresh useFileTree on error", async () => {
    postNotesMock.mockResolvedValue({
      error: { code: "case_collision", message: "x", status: 409 },
    });

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await expect(
      act(async () => {
        await result.current.muts.createNote("", "untitled");
      }),
    ).rejects.toBeInstanceOf(TreeMutationError);

    await new Promise((r) => setTimeout(r, 10));
    expect(getTreeMock).toHaveBeenCalledTimes(1);
  });

  it("deleteNote refreshes useFileTree after success", async () => {
    deleteNoteByIdMock.mockResolvedValue({});

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.muts.deleteNote("n1");
    });

    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(2));
  });

  it("deleteNote does NOT refresh useFileTree on error", async () => {
    deleteNoteByIdMock.mockResolvedValue({
      error: { code: "not_found", message: "missing", status: 404 },
    });

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await expect(
      act(async () => {
        await result.current.muts.deleteNote("missing");
      }),
    ).rejects.toBeInstanceOf(TreeMutationError);

    await new Promise((r) => setTimeout(r, 10));
    expect(getTreeMock).toHaveBeenCalledTimes(1);
  });

  it("moveNote refreshes useFileTree after success", async () => {
    postNoteMoveMock.mockResolvedValue({
      data: {
        id: "n1",
        path: "ideas/n1.md",
        title: "n1",
        updated_at: "2026-01-01T00:00:00Z",
      },
    });

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.muts.moveNote("n1", "ideas/n1.md");
    });

    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(2));
  });

  it("moveNote does NOT refresh useFileTree on error", async () => {
    postNoteMoveMock.mockResolvedValue({
      error: { code: "case_collision", message: "x", status: 409 },
    });

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await expect(
      act(async () => {
        await result.current.muts.moveNote("n1", "ideas/n1.md");
      }),
    ).rejects.toBeInstanceOf(TreeMutationError);

    await new Promise((r) => setTimeout(r, 10));
    expect(getTreeMock).toHaveBeenCalledTimes(1);
  });

  it("createFolder refreshes useFileTree after success", async () => {
    postFoldersMock.mockResolvedValue({
      data: { kind: "folder", path: "ideas", name: "ideas" },
    });

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.muts.createFolder("", "ideas");
    });

    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(2));
  });

  it("createFolder does NOT refresh useFileTree on error", async () => {
    postFoldersMock.mockResolvedValue({
      error: { code: "invalid_request", message: "bad name", status: 400 },
    });

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await expect(
      act(async () => {
        await result.current.muts.createFolder("", "bad/name");
      }),
    ).rejects.toBeInstanceOf(TreeMutationError);

    await new Promise((r) => setTimeout(r, 10));
    expect(getTreeMock).toHaveBeenCalledTimes(1);
  });

  it("deleteFolder refreshes useFileTree after success", async () => {
    deleteFolderMock.mockResolvedValue({});

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.muts.deleteFolder("projects/old", true);
    });

    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(2));
  });

  it("deleteFolder does NOT refresh useFileTree on error", async () => {
    deleteFolderMock.mockResolvedValue({
      error: {
        code: "folder_not_empty",
        message: "has children",
        status: 409,
      },
    });

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await expect(
      act(async () => {
        await result.current.muts.deleteFolder("projects", false);
      }),
    ).rejects.toBeInstanceOf(TreeMutationError);

    await new Promise((r) => setTimeout(r, 10));
    expect(getTreeMock).toHaveBeenCalledTimes(1);
  });

  it("moveFolder refreshes useFileTree after success", async () => {
    postFolderMoveMock.mockResolvedValue({
      data: { kind: "folder", path: "projects/new", name: "new" },
    });

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.muts.moveFolder(
        "projects/old",
        "projects/new",
      );
    });

    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(2));
  });

  it("moveFolder does NOT refresh useFileTree on error", async () => {
    postFolderMoveMock.mockResolvedValue({
      error: { code: "case_collision", message: "x", status: 409 },
    });

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await expect(
      act(async () => {
        await result.current.muts.moveFolder(
          "projects/old",
          "projects/new",
        );
      }),
    ).rejects.toBeInstanceOf(TreeMutationError);

    await new Promise((r) => setTimeout(r, 10));
    expect(getTreeMock).toHaveBeenCalledTimes(1);
  });

  it("UTM-MOVEFILE-1: moveFile calls filesApi.moveFile with src and dst paths", async () => {
    filesApiMoveFileMock.mockResolvedValue({
      path: "folderA/upload.png",
      name: "upload.png",
    });

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.muts.moveFile("upload.png", "folderA/upload.png");
    });

    expect(filesApiMoveFileMock).toHaveBeenCalledWith(
      "upload.png",
      "folderA/upload.png",
    );
  });

  it("UTM-MOVEFILE-2: moveFile refreshes useFileTree after success", async () => {
    filesApiMoveFileMock.mockResolvedValue({
      path: "folderA/upload.png",
      name: "upload.png",
    });

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.muts.moveFile("upload.png", "folderA/upload.png");
    });

    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(2));
  });

  it("UTM-MOVEFILE-3: moveFile surfaces an error on 409 (no refresh)", async () => {
    const err = new Error("moveFile failed: 409") as Error & { status?: number };
    err.status = 409;
    filesApiMoveFileMock.mockRejectedValue(err);

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await expect(
      act(async () => {
        await result.current.muts.moveFile("upload.png", "folderA/upload.png");
      }),
    ).rejects.toThrow();

    await new Promise((r) => setTimeout(r, 10));
    expect(getTreeMock).toHaveBeenCalledTimes(1);
  });


  it("UTM-MOVEFILE-404-RECONCILE-1: moveFile swallows 404 when file is at dst after refresh", async () => {
    const err = new Error("moveFile failed: 404") as Error & {
      status?: number;
    };
    err.status = 404;
    filesApiMoveFileMock.mockRejectedValue(err);

    getTreeMock.mockResolvedValue({
      data: {
        root: [
          {
            kind: "folder",
            path: "folderA",
            name: "folderA",
            children: [
              {
                kind: "file",
                path: "folderA/upload.png",
                name: "upload.png",
              },
            ],
          },
        ],
      },
    });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.muts.moveFile(
        "upload.png",
        "folderA/upload.png",
      );
    });

    expect(consoleErrorSpy).toHaveBeenCalled();
    const logCall = consoleErrorSpy.mock.calls.find((args) =>
      args.some(
        (a) => typeof a === "string" && a.includes("[moveFile] 404"),
      ),
    );
    expect(logCall, "expected [moveFile] 404 console.error breadcrumb").toBeTruthy();

    await waitFor(() =>
      expect(getTreeMock.mock.calls.length).toBeGreaterThanOrEqual(2),
    );

    consoleErrorSpy.mockRestore();
  });

  it("UTM-MOVEFILE-404-REAL-1: moveFile rethrows 404 when file is NOT at dst after refresh", async () => {
    const err = new Error("moveFile failed: 404") as Error & {
      status?: number;
    };
    err.status = 404;
    filesApiMoveFileMock.mockRejectedValue(err);

    getTreeMock.mockResolvedValue({ data: { root: [] } });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { result } = harness();
    await waitFor(() => expect(getTreeMock).toHaveBeenCalledTimes(1));

    await expect(
      act(async () => {
        await result.current.muts.moveFile(
          "upload.png",
          "folderA/upload.png",
        );
      }),
    ).rejects.toThrow();

    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});

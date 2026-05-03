/**
 * Tests for useTreeMutations — Phase 3 typed mutation hooks.
 *
 * Each hook wraps a treeApi.* call and either returns the typed payload on
 * success or throws a TreeMutationError carrying the server's { code, message,
 * status } so callers can branch and surface destructive toasts.
 *
 * The treeApi module is mocked so we can synthesize success / error responses
 * without touching the network. UI-SPEC §Surface 5 lists the canonical error
 * codes the consumer (Plan 03-07) maps to toast copy.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const postNotesMock = vi.fn();
const deleteNoteByIdMock = vi.fn();
const postNoteMoveMock = vi.fn();
const postFoldersMock = vi.fn();
const deleteFolderMock = vi.fn();
const postFolderMoveMock = vi.fn();

vi.mock("./treeApi", () => ({
  postNotes: (...args: unknown[]) => postNotesMock(...args),
  deleteNoteById: (...args: unknown[]) => deleteNoteByIdMock(...args),
  postNoteMove: (...args: unknown[]) => postNoteMoveMock(...args),
  postFolders: (...args: unknown[]) => postFoldersMock(...args),
  deleteFolder: (...args: unknown[]) => deleteFolderMock(...args),
  postFolderMove: (...args: unknown[]) => postFolderMoveMock(...args),
}));

import { TreeMutationError, useTreeMutations } from "./useTreeMutations";

describe("useTreeMutations", () => {
  beforeEach(() => {
    postNotesMock.mockReset();
    deleteNoteByIdMock.mockReset();
    postNoteMoveMock.mockReset();
    postFoldersMock.mockReset();
    deleteFolderMock.mockReset();
    postFolderMoveMock.mockReset();
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

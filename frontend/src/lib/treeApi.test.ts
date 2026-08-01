/**
 * Tests for treeApi typed-fetch wrappers.
 * The client module is mocked so we can spy on .GET / .POST / .DELETE calls
 * and synthesize responses without touching the network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const postMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("../api/client", () => ({
  client: {
    GET: (...args: unknown[]) => getMock(...args),
    POST: (...args: unknown[]) => postMock(...args),
    DELETE: (...args: unknown[]) => deleteMock(...args),
    PUT: vi.fn(),
  },
}));

import {
  deleteFolder,
  deleteNoteById,
  postFolderMove,
  postFolders,
  postNoteMove,
  postNotes,
  treeResource,
  walkTreeCollect,
  type Tree,
} from "./treeApi";
import { __testing__ as resourcesTesting } from "./resources/createResource";
import { useTreeStore } from "./useTreeStore";

describe("treeApi", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    deleteMock.mockReset();
    // treeResource is a module-level "cached" singleton — reset between
    // tests so each treeResource.read() below issues a fresh fetch instead
    // of returning a previous test's cached value.
    resourcesTesting.reset();
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: null,
      pendingRename: null,
      draftCreate: null,
    });
  });

  it("TestGetTree_HappyPath: treeResource.read() returns data when client.GET resolves with a tree", async () => {
    const tree = {
      root: [
        { kind: "folder", path: "projects", name: "projects", children: [] },
      ],
    };
    getMock.mockResolvedValue({
      data: tree,
      error: undefined,
      response: { status: 200 },
    });

    const result = await treeResource.read();

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith("/tree");
    expect(result.data).toEqual(tree);
    expect(result.error).toBeUndefined();
  });

  it("TestGetTree_5xx_PassesError: 500 response is translated into ApiError shape", async () => {
    getMock.mockResolvedValue({
      data: undefined,
      error: { code: "tree_projection_failed", message: "fs walk failed" },
      response: { status: 500 },
    });

    const result = await treeResource.read();

    expect(result.data).toBeUndefined();
    expect(result.error).toEqual({
      code: "tree_projection_failed",
      message: "fs walk failed",
      status: 500,
    });
  });

  it("TestFetchTree_PrunesStaleTreeState: a successful fetch prunes expanded paths / activeNoteId absent from the fresh tree", async () => {
    useTreeStore.setState({
      expanded: new Set(["old-folder", "projects"]),
      activeNoteId: "stale-uuid",
    });
    const tree = {
      root: [
        {
          kind: "folder",
          path: "projects",
          name: "projects",
          children: [
            {
              kind: "note",
              id: "uuid-a",
              path: "projects/a.md",
              title: "a",
              updated_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      ],
    };
    getMock.mockResolvedValue({ data: tree, error: undefined, response: { status: 200 } });

    await treeResource.read();

    const s = useTreeStore.getState();
    expect(s.expanded.has("projects")).toBe(true);
    expect(s.expanded.has("old-folder")).toBe(false);
    expect(s.activeNoteId).toBeNull();
  });

  it("TestWalkTreeCollect_CollectsFoldersAndNotes: exported for MoveToFolderModal + this file's own pruning logic", () => {
    const tree: Tree = {
      root: [
        {
          kind: "folder",
          path: "projects",
          name: "projects",
          children: [
            {
              kind: "note",
              id: "uuid-a",
              path: "projects/a.md",
              title: "a",
              updated_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      ],
    };
    const { folders, notes } = walkTreeCollect(tree);
    expect(folders.has("projects")).toBe(true);
    expect(notes.has("uuid-a")).toBe(true);
  });

  it("TestPostNotes_HappyPath: routes to /notes with the correct body", async () => {
    postMock.mockResolvedValue({
      data: {
        id: "00000000-0000-4000-a000-000000000002",
        path: "projects/scratch.md",
        title: "scratch",
        updated_at: "2026-01-01T00:00:00Z",
      },
      error: undefined,
      response: { status: 201 },
    });

    const result = await postNotes({ parent_path: "projects", title: "scratch" });

    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith("/notes", {
      body: { parent_path: "projects", title: "scratch" },
    });
    expect(result.data?.path).toBe("projects/scratch.md");
  });

  it("TestPostNotes_409_HasStatus: case_collision is translated with status=409", async () => {
    postMock.mockResolvedValue({
      data: undefined,
      error: { code: "case_collision", message: "already exists" },
      response: { status: 409 },
    });

    const result = await postNotes({ parent_path: "", title: "Scratchpad" });

    expect(result.error).toEqual({
      code: "case_collision",
      message: "already exists",
      status: 409,
    });
  });

  it("TestDeleteNoteById_204: empty success returns {} with no error", async () => {
    deleteMock.mockResolvedValue({
      data: undefined,
      error: undefined,
      response: { status: 204 },
    });

    const result = await deleteNoteById("uuid-x");

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith("/notes/{id}", {
      params: { path: { id: "uuid-x" } },
    });
    expect(result.error).toBeUndefined();
  });

  it("TestDeleteNoteById_404: passes through code=not_found with status=404", async () => {
    deleteMock.mockResolvedValue({
      data: undefined,
      error: { code: "not_found", message: "no note" },
      response: { status: 404 },
    });

    const result = await deleteNoteById("missing-id");

    expect(result.error).toEqual({
      code: "not_found",
      message: "no note",
      status: 404,
    });
  });

  it("TestPostNoteMove_PassesPathAndBody: path uuid + body new_path are wired correctly", async () => {
    postMock.mockResolvedValue({
      data: {
        id: "uuid-z",
        path: "ideas/scratch.md",
        title: "scratch",
        updated_at: "2026-01-01T00:00:00Z",
      },
      error: undefined,
      response: { status: 200 },
    });

    const result = await postNoteMove("uuid-z", "ideas/scratch.md");

    expect(postMock).toHaveBeenCalledWith("/notes/{id}/move", {
      params: { path: { id: "uuid-z" } },
      body: { new_path: "ideas/scratch.md" },
    });
    expect(result.data?.path).toBe("ideas/scratch.md");
  });

  it("TestPostFolders_HappyPath: routes to /folders with parent_path + name", async () => {
    postMock.mockResolvedValue({
      data: { kind: "folder", path: "ideas", name: "ideas" },
      error: undefined,
      response: { status: 201 },
    });

    const result = await postFolders({ parent_path: "", name: "ideas" });

    expect(postMock).toHaveBeenCalledWith("/folders", {
      body: { parent_path: "", name: "ideas" },
    });
    expect(result.data?.name).toBe("ideas");
  });

  it("TestDeleteFolder_QueryParams: path + recursive ride along as query params", async () => {
    deleteMock.mockResolvedValue({
      data: undefined,
      error: undefined,
      response: { status: 204 },
    });

    await deleteFolder("projects/old", true);
    expect(deleteMock).toHaveBeenCalledWith("/folders", {
      params: { query: { path: "projects/old", recursive: true } },
    });

    await deleteFolder("projects/old", false);
    expect(deleteMock).toHaveBeenLastCalledWith("/folders", {
      params: { query: { path: "projects/old", recursive: false } },
    });
  });

  it("TestDeleteFolder_409_NotEmpty: passes through folder_not_empty with status=409", async () => {
    deleteMock.mockResolvedValue({
      data: undefined,
      error: { code: "folder_not_empty", message: "has children" },
      response: { status: 409 },
    });

    const result = await deleteFolder("projects", false);

    expect(result.error).toEqual({
      code: "folder_not_empty",
      message: "has children",
      status: 409,
    });
  });

  it("TestPostFolderMove_ReturnsFolderNode: 200 response surfaces the FolderNode shape", async () => {
    postMock.mockResolvedValue({
      data: { kind: "folder", path: "projects/new-name", name: "new-name" },
      error: undefined,
      response: { status: 200 },
    });

    const result = await postFolderMove("projects/old-name", "projects/new-name");

    expect(postMock).toHaveBeenCalledWith("/folders/move", {
      body: { old_path: "projects/old-name", new_path: "projects/new-name" },
    });
    expect(result.data?.path).toBe("projects/new-name");
    expect(result.data?.name).toBe("new-name");
  });

  it("PassThroughError_NonObject_DefaultsToUnknown: malformed error body still surfaces with status", async () => {
    postMock.mockResolvedValue({
      data: undefined,
      error: "totally malformed",
      response: { status: 500 },
    });

    const result = await postNotes({ parent_path: "", title: "x" });

    expect(result.error?.status).toBe(500);
    expect(result.error?.code).toBe("unknown");
    expect(result.error?.message).toBe("request failed");
  });
});

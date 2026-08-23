/**
 * The client module is mocked so folder writes can be driven to a 409 without
 * a network connection. A name clash must arrive as its own error type — the
 * inline create/rename input distinguishes it from a generic failure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const postMock = vi.fn();
const putMock = vi.fn();

vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn(),
    POST: (...args: unknown[]) => postMock(...args),
    PUT: (...args: unknown[]) => putMock(...args),
    DELETE: vi.fn(),
  },
}));

import {
  BookmarkFolderNameConflictError,
  postBookmarkFolder,
  putBookmarkFolder,
} from "./bookmarksApi";

const folder = { id: "f-1", name: "Work" };

describe("bookmark folder writes", () => {
  beforeEach(() => {
    postMock.mockReset();
    putMock.mockReset();
  });

  it("postBookmarkFolder throws BookmarkFolderNameConflictError on 409", async () => {
    postMock.mockResolvedValue({
      data: undefined,
      error: { code: "conflict", message: "a folder with this name already exists" },
      response: { status: 409 },
    });

    await expect(postBookmarkFolder("work")).rejects.toBeInstanceOf(
      BookmarkFolderNameConflictError,
    );
  });

  it("postBookmarkFolder throws a plain Error on a non-409 failure", async () => {
    postMock.mockResolvedValue({
      data: undefined,
      error: { code: "invalid_request", message: "name must not be empty" },
      response: { status: 400 },
    });

    const err = await postBookmarkFolder("").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BookmarkFolderNameConflictError);
  });

  it("putBookmarkFolder returns the renamed folder", async () => {
    putMock.mockResolvedValue({
      data: { id: "f-1", name: "Personal" },
      error: undefined,
      response: { status: 200 },
    });

    await expect(putBookmarkFolder("f-1", "Personal")).resolves.toEqual({
      id: "f-1",
      name: "Personal",
    });
    expect(putMock).toHaveBeenCalledWith("/bookmark-folders/{id}", {
      params: { path: { id: "f-1" } },
      body: { name: "Personal" },
    });
  });

  it("putBookmarkFolder throws BookmarkFolderNameConflictError on 409", async () => {
    putMock.mockResolvedValue({
      data: undefined,
      error: { code: "conflict", message: "a folder with this name already exists" },
      response: { status: 409 },
    });

    await expect(putBookmarkFolder("f-1", "work")).rejects.toBeInstanceOf(
      BookmarkFolderNameConflictError,
    );
  });

  it("postBookmarkFolder still resolves the created folder on success", async () => {
    postMock.mockResolvedValue({
      data: folder,
      error: undefined,
      response: { status: 201 },
    });

    await expect(postBookmarkFolder("Work")).resolves.toEqual(folder);
  });
});

/**
 * Tests for tagsApi typed wrappers. Validates that:
 *   - listTags routes through client.GET("/api/v1/tags") correctly
 *   - listTagNotes routes through client.GET("/api/v1/tags/{name}/notes") correctly
 *   - renameTag routes through client.PUT("/api/v1/tags/{name}") correctly
 *   - deleteTag routes through client.DELETE("/api/v1/tags/{name}") correctly
 *   - Non-2xx errors throw an Error with the server's error message
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const putMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("../api/client", () => ({
  client: {
    GET: (...args: unknown[]) => getMock(...args),
    PUT: (...args: unknown[]) => putMock(...args),
    DELETE: (...args: unknown[]) => deleteMock(...args),
  },
}));

import { listTags, listTagNotes, renameTag, deleteTag } from "./tagsApi";

describe("tagsApi", () => {
  beforeEach(() => {
    getMock.mockReset();
    putMock.mockReset();
    deleteMock.mockReset();
  });

  describe("listTags", () => {
    it("T1: routes through client.GET /api/v1/tags and returns tags array", async () => {
      const fakeTags = [
        { name: "project", count: 5 },
        { name: "work", count: 3 },
      ];
      getMock.mockResolvedValue({ data: { tags: fakeTags }, error: undefined });

      const result = await listTags();

      expect(getMock).toHaveBeenCalledTimes(1);
      expect(getMock).toHaveBeenCalledWith("/api/v1/tags");
      expect(result).toEqual(fakeTags);
    });

    it("T2: throws Error on non-2xx response", async () => {
      getMock.mockResolvedValue({
        data: undefined,
        error: { code: "internal_error", message: "server error" },
      });

      await expect(listTags()).rejects.toThrow();
    });
  });

  describe("listTagNotes", () => {
    it("T3: routes through client.GET /api/v1/tags/{name}/notes with path param", async () => {
      const fakeNotes = [
        { id: "uuid-1", path: "note1.md", title: "Note One", updated_at: "2026-01-01T00:00:00Z" },
      ];
      getMock.mockResolvedValue({ data: { notes: fakeNotes }, error: undefined });

      const result = await listTagNotes("project");

      expect(getMock).toHaveBeenCalledTimes(1);
      expect(getMock).toHaveBeenCalledWith("/api/v1/tags/{name}/notes", {
        params: { path: { name: "project" } },
      });
      expect(result).toEqual(fakeNotes);
    });

    it("T4: throws Error when server returns an error", async () => {
      getMock.mockResolvedValue({
        data: undefined,
        error: { code: "not_found", message: "tag not found" },
      });

      await expect(listTagNotes("nonexistent")).rejects.toThrow();
    });
  });

  describe("renameTag", () => {
    it("T5: routes through client.PUT /api/v1/tags/{name} with old name in path and new_name in body", async () => {
      const fakeResponse = {
        old_name: "project",
        new_name: "work",
        touched_note_ids: ["uuid-1", "uuid-2"],
      };
      putMock.mockResolvedValue({ data: fakeResponse, error: undefined });

      const result = await renameTag("project", "work");

      expect(putMock).toHaveBeenCalledTimes(1);
      expect(putMock).toHaveBeenCalledWith("/api/v1/tags/{name}", {
        params: { path: { name: "project" } },
        body: { new_name: "work" },
      });
      expect(result).toEqual(fakeResponse);
    });

    it("T6: throws Error on rename failure", async () => {
      putMock.mockResolvedValue({
        data: undefined,
        error: { code: "conflict", message: "tag already exists" },
      });

      await expect(renameTag("project", "work")).rejects.toThrow();
    });
  });

  describe("deleteTag", () => {
    it("T7: routes through client.DELETE /api/v1/tags/{name} with correct path param", async () => {
      const fakeResponse = {
        old_name: "project",
        touched_note_ids: ["uuid-1"],
      };
      deleteMock.mockResolvedValue({ data: fakeResponse, error: undefined });

      const result = await deleteTag("project");

      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledWith("/api/v1/tags/{name}", {
        params: { path: { name: "project" } },
      });
      expect(result).toEqual(fakeResponse);
    });

    it("T8: throws Error on delete failure", async () => {
      deleteMock.mockResolvedValue({
        data: undefined,
        error: { code: "not_found", message: "tag not found" },
      });

      await expect(deleteTag("nonexistent")).rejects.toThrow();
    });
  });
});

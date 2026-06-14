/**
 * Tests for notesApi typed-client wrappers.
 * The client module is mocked so we can spy on .GET / .PUT calls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const putMock = vi.fn();

vi.mock("../api/client", () => ({
  client: {
    GET: (...args: unknown[]) => getMock(...args),
    PUT: (...args: unknown[]) => putMock(...args),
  },
}));

import { ScratchpadUUID, getNote, updateNote } from "./notesApi";

describe("notesApi", () => {
  beforeEach(() => {
    getMock.mockReset();
    putMock.mockReset();
  });

  it("N1: getNote routes through client.GET with the correct path key + params", async () => {
    getMock.mockResolvedValue({
      data: {
        id: ScratchpadUUID,
        path: "scratchpad.md",
        content: "abc",
        updated_at: "2025-01-01T00:00:00Z",
      },
      error: undefined,
    });

    const result = await getNote(ScratchpadUUID);

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith("/notes/{id}", {
      params: { path: { id: ScratchpadUUID } },
    });
    expect(result.data?.content).toBe("abc");
  });

  it("N2: updateNote routes through client.PUT with body.content + same path param", async () => {
    putMock.mockResolvedValue({
      data: {
        id: ScratchpadUUID,
        path: "scratchpad.md",
        updated_at: "2025-01-01T00:00:00Z",
      },
      error: undefined,
    });

    const result = await updateNote(ScratchpadUUID, "hello world");

    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock).toHaveBeenCalledWith("/notes/{id}", {
      params: { path: { id: ScratchpadUUID } },
      body: { content: "hello world" },
    });
    expect(result.data?.id).toBe(ScratchpadUUID);
  });

  it("N3: ScratchpadUUID matches the locked byte-for-byte constant from D-06", () => {
    expect(ScratchpadUUID).toBe("00000000-0000-4000-a000-000000000001");
  });

  it("propagates errors from the client without reshaping them", async () => {
    const fakeError = { code: "not_found", message: "no note" };
    getMock.mockResolvedValue({ data: undefined, error: fakeError });

    const result = await getNote(ScratchpadUUID);
    expect(result.error).toEqual(fakeError);
    expect(result.data).toBeUndefined();
  });

  it("N4: updateNote attaches If-Match header when supplied", async () => {
    putMock.mockResolvedValue({ data: undefined, error: undefined });
    await updateNote(ScratchpadUUID, "x", "2026-05-06T12:00:00Z");
    expect(putMock).toHaveBeenCalledWith("/notes/{id}", {
      params: { path: { id: ScratchpadUUID } },
      body: { content: "x" },
      headers: { "If-Match": "2026-05-06T12:00:00Z" },
    });
  });

  it("N5: updateNote omits If-Match header when not supplied", async () => {
    putMock.mockResolvedValue({ data: undefined, error: undefined });
    await updateNote(ScratchpadUUID, "x");
    expect(putMock).toHaveBeenCalledWith("/notes/{id}", {
      params: { path: { id: ScratchpadUUID } },
      body: { content: "x" },
    });
  });
});

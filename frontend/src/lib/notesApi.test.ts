/**
 * Tests for notesApi typed-client wrappers.
 * The client module is mocked so we can spy on .GET / .PUT calls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __testing__ as resourcesTesting } from "./resources/createResource";
import { __testing__ as eventBusTesting } from "./resources/eventBus";

const getMock = vi.fn();
const putMock = vi.fn();

vi.mock("../api/client", () => ({
  client: {
    GET: (...args: unknown[]) => getMock(...args),
    PUT: (...args: unknown[]) => putMock(...args),
  },
}));

import {
  ScratchpadUUID,
  getNote,
  getNoteByPath,
  getNoteFresh,
  updateNote,
} from "./notesApi";

describe("notesApi", () => {
  beforeEach(() => {
    getMock.mockReset();
    putMock.mockReset();
    resourcesTesting.reset();
    eventBusTesting.reset();
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

  it("N6 (D-05): two concurrent getNote() calls for the same id issue exactly one client.GET and both resolve from it", async () => {
    let resolveFetch!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    getMock.mockReturnValueOnce(pending);

    const p1 = getNote(ScratchpadUUID);
    const p2 = getNote(ScratchpadUUID);
    expect(getMock).toHaveBeenCalledTimes(1);

    resolveFetch({
      data: { id: ScratchpadUUID, path: "a.md", content: "x", updated_at: "" },
      error: undefined,
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
  });

  it("N7 (D-05): getNote() for two different ids issues two client.GET calls", async () => {
    getMock.mockResolvedValue({
      data: { id: "id", path: "a.md", content: "x", updated_at: "" },
      error: undefined,
    });

    await Promise.all([getNote("id-a"), getNote("id-b")]);

    expect(getMock).toHaveBeenCalledTimes(2);
    expect(getMock).toHaveBeenCalledWith("/notes/{id}", {
      params: { path: { id: "id-a" } },
    });
    expect(getMock).toHaveBeenCalledWith("/notes/{id}", {
      params: { path: { id: "id-b" } },
    });
  });

  it("N8 (D-12): getNoteFresh issued while a getNote read is in flight never joins it — issues a second request and resolves against that", async () => {
    let resolveStale!: (v: unknown) => void;
    const stale = new Promise((resolve) => {
      resolveStale = resolve;
    });
    getMock
      .mockReturnValueOnce(stale)
      .mockResolvedValueOnce({
        data: {
          id: ScratchpadUUID,
          path: "a.md",
          content: "fresh-content",
          updated_at: "",
        },
        error: undefined,
      });

    const readCall = getNote(ScratchpadUUID);
    expect(getMock).toHaveBeenCalledTimes(1);

    const freshCall = getNoteFresh(ScratchpadUUID);

    resolveStale({
      data: {
        id: ScratchpadUUID,
        path: "a.md",
        content: "stale-content",
        updated_at: "",
      },
      error: undefined,
    });

    const [readResult, freshResult] = await Promise.all([readCall, freshCall]);
    expect((readResult.data as { content: string }).content).toBe(
      "stale-content",
    );
    expect((freshResult.data as { content: string }).content).toBe(
      "fresh-content",
    );
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it("N9: getNote with an AbortSignal always issues its own request, bypassing the coalescer", async () => {
    getMock.mockResolvedValue({
      data: { id: ScratchpadUUID, path: "a.md", content: "x", updated_at: "" },
      error: undefined,
    });
    const controller = new AbortController();

    await getNote(ScratchpadUUID, { signal: controller.signal });
    await getNote(ScratchpadUUID, { signal: controller.signal });

    expect(getMock).toHaveBeenCalledTimes(2);
    expect(getMock).toHaveBeenCalledWith("/notes/{id}", {
      params: { path: { id: ScratchpadUUID } },
      signal: controller.signal,
    });
  });

  it("N10: getNoteByPath hits /notes/by-path with the path as a query param", async () => {
    getMock.mockResolvedValue({
      data: { id: ScratchpadUUID, path: "a.md", content: "x", updated_at: "" },
      error: undefined,
    });

    const result = await getNoteByPath("projects/alpha.md");

    expect(getMock).toHaveBeenCalledWith("/notes/by-path", {
      params: { query: { path: "projects/alpha.md" } },
    });
    expect(result.data?.id).toBe(ScratchpadUUID);
  });

  it("N11 (D-05): two concurrent getNoteByPath() calls for the same path issue exactly one client.GET", async () => {
    let resolveFetch!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    getMock.mockReturnValueOnce(pending);

    const p1 = getNoteByPath("a.md");
    const p2 = getNoteByPath("a.md");
    expect(getMock).toHaveBeenCalledTimes(1);

    resolveFetch({
      data: { id: ScratchpadUUID, path: "a.md", content: "x", updated_at: "" },
      error: undefined,
    });
    await Promise.all([p1, p2]);
  });
});

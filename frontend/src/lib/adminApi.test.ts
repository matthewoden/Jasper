/**
 * Mirrors notesApi.test.ts's mocking pattern: spy on client.GET / client.POST so
 * the network is never hit. Error responses are asserted as propagated, not thrown.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock("../api/client", () => ({
  client: {
    GET: (...args: unknown[]) => getMock(...args),
    POST: (...args: unknown[]) => postMock(...args),
  },
}));

import { getAdminStatus, postAdminReindex } from "./adminApi";
import { __testing__ as resourcesTesting } from "./resources/createResource";

describe("adminApi", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    // getAdminStatus now reads adminStatusResource (mode: "cached") — reset
    // between tests so each getAdminStatus() call below issues a fresh
    // fetch instead of returning a previous test's cached value.
    resourcesTesting.reset();
  });

  it("AS1: getAdminStatus routes through client.GET with the locked path key", async () => {
    getMock.mockResolvedValue({
      data: { state: "ok", notes_indexed: 0 },
      error: undefined,
    });

    const result = await getAdminStatus();

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith("/admin/status");
    expect(result.data?.state).toBe("ok");
  });

  it("AS2: getAdminStatus surfaces a rolled_back state with failed_migration + logs_path verbatim", async () => {
    getMock.mockResolvedValue({
      data: {
        state: "rolled_back",
        failed_migration: "003_tags.sql",
        logs_path: "/tmp/jasper.log",
      },
      error: undefined,
    });

    const result = await getAdminStatus();
    expect(result.data?.state).toBe("rolled_back");
    expect(result.data?.failed_migration).toBe("003_tags.sql");
    expect(result.data?.logs_path).toBe("/tmp/jasper.log");
  });

  it("AS3: postAdminReindex defaults to mode='full' in the body", async () => {
    postMock.mockResolvedValue({
      data: { started_at: "2025-01-01T00:00:00Z", notes_indexed: 7 },
      error: undefined,
    });

    await postAdminReindex();

    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith("/admin/reindex", {
      body: { mode: "full" },
    });
  });

  it("AS4: postAdminReindex('incremental') sends the alternate mode verbatim", async () => {
    postMock.mockResolvedValue({
      data: { started_at: "2025-01-01T00:00:00Z" },
      error: undefined,
    });

    await postAdminReindex("incremental");

    expect(postMock).toHaveBeenCalledWith("/admin/reindex", {
      body: { mode: "incremental" },
    });
  });

  it("AS5: postAdminReindex propagates a 503 error response without throwing", async () => {
    const fakeError = { code: "unrecoverable", message: "db is bad" };
    postMock.mockResolvedValue({ data: undefined, error: fakeError });

    const result = await postAdminReindex("full");
    expect(result.error).toEqual(fakeError);
    expect(result.data).toBeUndefined();
  });

  it("AS6: getAdminStatus propagates an error response without throwing", async () => {
    const fakeError = { code: "internal", message: "boom" };
    getMock.mockResolvedValue({ data: undefined, error: fakeError });

    const result = await getAdminStatus();
    expect(result.error).toEqual(fakeError);
  });
});

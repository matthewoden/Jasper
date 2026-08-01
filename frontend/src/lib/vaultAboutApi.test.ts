/**
 * vaultAboutApi.test — vaultAboutResource.read() resolves to `data` on
 * success and `error` (with HTTP status) on failure, never throwing. The
 * raw fetcher is private (D-17), so read() through the resource is the
 * module's only public fetch surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn(),
  },
}));

import { client } from "../api/client";
import { __testing__ as resourcesTesting } from "./resources/createResource";
import { vaultAboutResource } from "./vaultAboutApi";

const mockClient = client as unknown as {
  GET: ReturnType<typeof vi.fn>;
};

const sampleAbout = {
  vaultName: "my-vault",
  noteCount: 42,
  folderCount: 5,
  path: "/Users/me/.jasper/vaults/my-vault",
  appVersion: "1.4.0",
  mcpPort: 6684,
  mcpGrantCount: 2,
};

beforeEach(() => {
  mockClient.GET.mockReset();
  resourcesTesting.reset();
});

describe("vaultAboutResource.read()", () => {
  it("resolves data on a 200", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleAbout, response: { status: 200 } });
    const result = await vaultAboutResource.read();
    expect(result.data).toEqual(sampleAbout);
    expect(result.error).toBeUndefined();
    expect(mockClient.GET).toHaveBeenCalledWith("/vault/about");
  });

  it("resolves error with the HTTP status on a 500, never throws", async () => {
    mockClient.GET.mockResolvedValue({
      data: undefined,
      error: { code: "internal_error", message: "index unavailable" },
      response: { status: 500 },
    });
    const result = await vaultAboutResource.read();
    expect(result.data).toBeUndefined();
    expect(result.error).toEqual({
      code: "internal_error",
      message: "index unavailable",
      status: 500,
    });
  });

  it("resolves error instead of rejecting when the transport itself throws (32-REVIEW WR-05)", async () => {
    mockClient.GET.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await vaultAboutResource.read();
    expect(result.data).toBeUndefined();
    expect(result.error?.code).toBe("network");
    expect(result.error?.status).toBe(0);
    expect(result.error?.message).toContain("Failed to fetch");
  });

  it("caches across repeated read() calls — exactly one client.GET for two reads (D-15)", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleAbout, response: { status: 200 } });
    await vaultAboutResource.read();
    await vaultAboutResource.read();
    expect(mockClient.GET).toHaveBeenCalledTimes(1);
  });
});

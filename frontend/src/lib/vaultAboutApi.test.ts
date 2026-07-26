/**
 * vaultAboutApi.test — getVaultAbout returns `data` on success and
 * `error` (with HTTP status) on failure, never throwing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn(),
  },
}));

import { client } from "../api/client";
import { getVaultAbout } from "./vaultAboutApi";

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
});

describe("getVaultAbout", () => {
  it("returns data on a 200", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleAbout, response: { status: 200 } });
    const result = await getVaultAbout();
    expect(result.data).toEqual(sampleAbout);
    expect(result.error).toBeUndefined();
    expect(mockClient.GET).toHaveBeenCalledWith("/vault/about");
  });

  it("returns error with the HTTP status on a 500, never throws", async () => {
    mockClient.GET.mockResolvedValue({
      data: undefined,
      error: { code: "internal_error", message: "index unavailable" },
      response: { status: 500 },
    });
    const result = await getVaultAbout();
    expect(result.data).toBeUndefined();
    expect(result.error).toEqual({
      code: "internal_error",
      message: "index unavailable",
      status: 500,
    });
  });

  it("returns error instead of rejecting when the transport itself throws (32-REVIEW WR-05)", async () => {
    mockClient.GET.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await getVaultAbout();
    expect(result.data).toBeUndefined();
    expect(result.error?.code).toBe("network");
    expect(result.error?.status).toBe(0);
    expect(result.error?.message).toContain("Failed to fetch");
  });
});

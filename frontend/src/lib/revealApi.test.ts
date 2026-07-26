/**
 * revealApi.test — verifies revealPath()'s default "note" scope, the
 * error-envelope mapping, and revealVaultRoot()'s fixed "." + "vaultRoot" body.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/client", () => ({
  client: {
    POST: vi.fn(),
  },
}));

import { client } from "../api/client";
import { revealPath, revealVaultRoot } from "./revealApi";

const mockClient = client as unknown as {
  POST: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mockClient.POST.mockReset();
});

describe("revealPath", () => {
  it("posts { path, scope: 'note' } by default and returns ok on success", async () => {
    mockClient.POST.mockResolvedValue({
      data: { platform: "darwin" },
      response: { status: 200 },
    });

    const result = await revealPath("notes/foo.md");

    expect(mockClient.POST).toHaveBeenCalledWith("/reveal", {
      body: { path: "notes/foo.md", scope: "note" },
    });
    expect(result).toEqual({ ok: true, platform: "darwin", status: 200 });
  });

  it("maps a non-2xx response to { ok: false, status, errorMessage }", async () => {
    mockClient.POST.mockResolvedValue({
      data: undefined,
      error: { message: "path traversal rejected" },
      response: { status: 400 },
    });

    const result = await revealPath("../etc/passwd");

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.errorMessage).toBe("path traversal rejected");
  });

  it("falls back to an HTTP-status message when no server message is present", async () => {
    mockClient.POST.mockResolvedValue({
      data: undefined,
      error: undefined,
      response: { status: 500 },
    });

    const result = await revealPath("foo.md");

    expect(result.errorMessage).toBe("HTTP 500");
  });
});

describe("revealVaultRoot", () => {
  it("posts a fixed '.' path with scope 'vaultRoot'", async () => {
    mockClient.POST.mockResolvedValue({
      data: { platform: "darwin" },
      response: { status: 200 },
    });

    const result = await revealVaultRoot();

    expect(mockClient.POST).toHaveBeenCalledWith("/reveal", {
      body: { path: ".", scope: "vaultRoot" },
    });
    expect(result).toEqual({ ok: true, platform: "darwin", status: 200 });
  });
});

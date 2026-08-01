/**
 * Tests for vaultApi — validateVaultPath and openapi-fetch wrappers.
 *
 * validateVaultPath is the client-side gate before POST /vault/create and
 * POST /vault/open. The backend repeats every check (defense-in-depth).
 * Client-side validation is UX; backend validation is security.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateVaultPath, vaultApi } from "./vaultApi";


describe("validateVaultPath", () => {
  it('rejects empty string with code "empty"', () => {
    const result = validateVaultPath("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("empty");
  });

  it('rejects relative paths with code "not-abs"', () => {
    const result = validateVaultPath("relative/path");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not-abs");
  });

  it('rejects paths with ".." segments with code "traversal"', () => {
    const result = validateVaultPath("/path/../bad");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("traversal");
  });

  it('rejects paths with double slashes with code "double-slash"', () => {
    const result = validateVaultPath("/path//with-double-slash");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("double-slash");
  });

  it('rejects paths with non-ASCII chars (emoji) with code "non-ascii"', () => {
    const result = validateVaultPath("/path/with-emoji-🦊");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("non-ascii");
  });

  it('rejects paths with decomposed (NFD) chars with code "non-nfc"', () => {
    const nfdE = "é";
    const nfdPath = `/caf${nfdE}/test`;
    expect(nfdPath.normalize("NFC")).not.toBe(nfdPath);
    const result = validateVaultPath(nfdPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("non-nfc");
  });

  it("accepts a valid absolute ASCII NFC-normalized path", () => {
    const result = validateVaultPath("/Users/me/Vault");
    expect(result.ok).toBe(true);
  });

  it("accepts a path with multiple segments", () => {
    const result = validateVaultPath("/home/user/Documents/MyNotes");
    expect(result.ok).toBe(true);
  });
});


vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn(),
    POST: vi.fn(),
  },
}));

describe("vaultApi openapi-fetch wrappers", () => {
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPost: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { client } = await import("../api/client");
    mockGet = vi.mocked(client.GET);
    mockPost = vi.mocked(client.POST);
  });

  it("getCurrent returns null when no vault open (empty wrapper from omitempty)", async () => {
    mockGet.mockResolvedValueOnce({ data: {}, error: undefined });
    const result = await vaultApi.getCurrent();
    expect(result).toBeNull();
    expect(mockGet).toHaveBeenCalledWith("/vault/current");
  });

  it("getCurrent returns null when wrapper.vault is explicitly null", async () => {
    mockGet.mockResolvedValueOnce({ data: { vault: null }, error: undefined });
    const result = await vaultApi.getCurrent();
    expect(result).toBeNull();
  });

  it("getCurrent returns entry when vault open (unwraps data.vault)", async () => {
    const entry = {
      path: "/Users/me/vault",
      display_name: "My Vault",
      last_opened_at: "2026-05-24T00:00:00Z",
      created_at: "2026-05-24T00:00:00Z",
      missing: false,
    };
    mockGet.mockResolvedValueOnce({ data: { vault: entry }, error: undefined });
    const result = await vaultApi.getCurrent();
    expect(result).toEqual(entry);
  });

  it("getCurrent coalesces concurrent callers into one client.GET (D-05)", async () => {
    let resolveGet!: (v: { data: unknown; error: undefined }) => void;
    mockGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve;
        }),
    );
    const p1 = vaultApi.getCurrent();
    const p2 = vaultApi.getCurrent();
    resolveGet({ data: {}, error: undefined });
    await Promise.all([p1, p2]);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("getRecent returns vaults and banner", async () => {
    const recent = {
      vaults: [
        {
          path: "/vault1",
          display_name: "Vault 1",
          last_opened_at: "2026-05-24T00:00:00Z",
          created_at: "2026-05-24T00:00:00Z",
          missing: false,
        },
      ],
      banner: "Previous vault missing",
    };
    mockGet.mockResolvedValueOnce({ data: recent, error: undefined });
    const result = await vaultApi.getRecent();
    expect(result.vaults).toHaveLength(1);
    expect(result.banner).toBe("Previous vault missing");
  });

  it("open rejects non-ASCII path before fetching", async () => {
    await expect(vaultApi.open("/path/with-emoji-🦊")).rejects.toThrow(/ASCII/i);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("open POSTs the path when valid", async () => {
    const entry = {
      path: "/Users/me/vault",
      display_name: "My Vault",
      last_opened_at: "2026-05-24T00:00:00Z",
      created_at: "2026-05-24T00:00:00Z",
      missing: false,
    };
    mockPost.mockResolvedValueOnce({ data: entry, error: undefined });
    const result = await vaultApi.open("/Users/me/vault");
    expect(result).toEqual(entry);
    expect(mockPost).toHaveBeenCalledWith("/vault/open", { body: { path: "/Users/me/vault" } });
  });

  it("create rejects traversal path before fetching", async () => {
    await expect(
      vaultApi.create({
        path: "/path/../traversal",
        theme: "dark",
        daily_template: "",
      }),
    ).rejects.toThrow(/\.\./);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("forget POSTs without throwing on success", async () => {
    mockPost.mockResolvedValueOnce({ error: undefined });
    await expect(vaultApi.forget("/Users/me/vault")).resolves.not.toThrow();
    expect(mockPost).toHaveBeenCalledWith("/vault/forget", { body: { path: "/Users/me/vault" } });
  });
});

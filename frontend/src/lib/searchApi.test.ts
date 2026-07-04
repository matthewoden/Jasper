import { describe, it, expect, vi, afterEach } from "vitest";
import { searchNotes } from "./searchApi";
import { client } from "../api/client";

vi.mock("../api/client", () => ({
  client: { GET: vi.fn() },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("searchApi.searchNotes", () => {
  it("calls GET /search with q, tag array, limit", async () => {
    (client.GET as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { results: [] },
      error: null,
    });
    await searchNotes("hello", ["project"], 25);
    expect(client.GET).toHaveBeenCalledWith("/search", {
      params: { query: { q: "hello", tag: ["project"], limit: 25 } },
    });
  });

  it("sends multiple tags as a repeated array", async () => {
    (client.GET as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { results: [] },
      error: null,
    });
    await searchNotes("hello", ["work", "draft"], 25);
    expect(client.GET).toHaveBeenCalledWith("/search", {
      params: { query: { q: "hello", tag: ["work", "draft"], limit: 25 } },
    });
  });

  it("omits tag param when undefined", async () => {
    (client.GET as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { results: [] },
      error: null,
    });
    await searchNotes("hello");
    const call = (client.GET as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { params: { query: Record<string, unknown> } },
    ];
    expect(call[1].params.query.tag).toBeUndefined();
  });

  it("omits tag param when tags is an empty array", async () => {
    (client.GET as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { results: [] },
      error: null,
    });
    await searchNotes("hello", []);
    const call = (client.GET as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { params: { query: Record<string, unknown> } },
    ];
    expect(call[1].params.query.tag).toBeUndefined();
  });

  it("uses default limit of 50", async () => {
    (client.GET as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { results: [] },
      error: null,
    });
    await searchNotes("hello");
    const call = (client.GET as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { params: { query: Record<string, unknown> } },
    ];
    expect(call[1].params.query.limit).toBe(50);
  });

  it("returns data.results array", async () => {
    const mockResults = [
      {
        id: "abc",
        title: "Test",
        path: "test.md",
        excerpt_html: "foo <mark>bar</mark>",
        matching_tags: [],
        rank: -1.5,
        modified_at: "2026-01-01T00:00:00Z",
      },
    ];
    (client.GET as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { results: mockResults },
      error: null,
    });
    const results = await searchNotes("bar");
    expect(results).toEqual(mockResults);
  });

  it("throws on error", async () => {
    (client.GET as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { code: "invalid_query" },
    });
    await expect(searchNotes("(")).rejects.toThrow("searchNotes:");
  });
});

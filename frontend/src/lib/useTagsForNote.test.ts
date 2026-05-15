/**
 * useTagsForNote.test.ts — Plan 07-35 / UAT-3 N3 (TDD RED phase).
 *
 * Tests: per-note tag count hook that replaces global useTagBrowser in TopBar.
 *
 * TGN-1: null noteId → tags: [], loading: false, error: null
 * TGN-2: uuid → fetches getNote, parses tags from content
 * TGN-3: noteId change → refetch with new id
 */
import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTagsForNote } from "./useTagsForNote";

// ── Mock notesApi ─────────────────────────────────────────────────────────────
vi.mock("./notesApi", () => ({
  getNote: vi.fn(),
}));

// Import after mock is set up
import { getNote } from "./notesApi";
const mockGetNote = vi.mocked(getNote);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a fake getNote response with the given content. */
function mockNoteResponse(content: string) {
  return Promise.resolve({
    data: {
      id: "note-uuid-1",
      path: "test/note.md",
      content,
      updated_at: "2026-01-01T00:00:00Z",
    },
    error: undefined,
    // openapi-fetch FetchResponse requires `response: Response`
    response: new Response(null, { status: 200 }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useTagsForNote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // TGN-1: null noteId → no fetch, empty tags
  it("TGN-1: returns empty tags when noteId is null", async () => {
    const { result } = renderHook(() => useTagsForNote(null));
    expect(result.current.tags).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockGetNote).not.toHaveBeenCalled();
  });

  // TGN-2: uuid → fetches getNote, parses tags from content (frontmatter + body)
  it("TGN-2: fetches getNote and returns tags parsed from content", async () => {
    const content = `---\ntags: [foo, bar]\n---\n\nSome note body with #baz inline.`;
    mockGetNote.mockReturnValueOnce(mockNoteResponse(content));

    const { result } = renderHook(() => useTagsForNote("note-uuid-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockGetNote).toHaveBeenCalledWith("note-uuid-1");
    expect(result.current.tags).toContain("foo");
    expect(result.current.tags).toContain("bar");
    expect(result.current.tags).toContain("baz");
    expect(result.current.error).toBeNull();
  });

  // TGN-2b: empty note → zero tags
  it("TGN-2b: returns empty tags when note has no tags", async () => {
    mockGetNote.mockReturnValueOnce(mockNoteResponse("---\ntags: []\n---\n\n# Hello"));

    const { result } = renderHook(() => useTagsForNote("note-uuid-2"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tags).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  // TGN-3: noteId change → refetch with new id
  it("TGN-3: refetches when noteId changes", async () => {
    mockGetNote
      .mockReturnValueOnce(mockNoteResponse("---\ntags: [alpha]\n---\n\n"))
      .mockReturnValueOnce(mockNoteResponse("---\ntags: [beta]\n---\n\n"));

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useTagsForNote(id),
      { initialProps: { id: "note-a" } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tags).toContain("alpha");

    rerender({ id: "note-b" });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockGetNote).toHaveBeenCalledWith("note-b");
    expect(result.current.tags).toContain("beta");
    expect(result.current.tags).not.toContain("alpha");
  });

  // TGN-3b: switching from uuid to null → clears tags immediately
  it("TGN-3b: switching to null noteId clears tags", async () => {
    mockGetNote.mockReturnValueOnce(mockNoteResponse("---\ntags: [alpha]\n---\n\n"));

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useTagsForNote(id),
      { initialProps: { id: "note-a" as string | null } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tags).toContain("alpha");

    rerender({ id: null });

    await waitFor(() => {
      expect(result.current.tags).toEqual([]);
      expect(result.current.loading).toBe(false);
    });
  });
});

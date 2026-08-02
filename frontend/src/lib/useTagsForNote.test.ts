/**
 * Tests for useTagsForNote — per-note tag hook.
 *
 * TGN-1: null noteId → tags: [], loading: false, error: null
 * TGN-2: uuid → fetches getNote, parses tags from content
 * TGN-3: noteId change → refetch with new id
 */
import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTagsForNote } from "./useTagsForNote";


vi.mock("./notesApi", () => ({
  getNote: vi.fn(),
}));


import { getNote } from "./notesApi";
const mockGetNote = vi.mocked(getNote);


/** Builds a minimal getNote response stub with the given content. */
function mockNoteResponse(content: string) {
  return Promise.resolve({
    data: {
      id: "note-uuid-1",
      path: "test/note.md",
      content,
      updated_at: "2026-01-01T00:00:00Z",
      etag: "2026-01-01T00:00:00Z",
    },
    error: undefined,
    response: new Response(null, { status: 200 }),
  });
}


describe("useTagsForNote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("TGN-1: returns empty tags when noteId is null", async () => {
    const { result } = renderHook(() => useTagsForNote(null));
    expect(result.current.tags).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockGetNote).not.toHaveBeenCalled();
  });

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

  it("TGN-2b: returns empty tags when note has no tags", async () => {
    mockGetNote.mockReturnValueOnce(mockNoteResponse("---\ntags: []\n---\n\n# Hello"));

    const { result } = renderHook(() => useTagsForNote("note-uuid-2"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tags).toEqual([]);
    expect(result.current.error).toBeNull();
  });

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

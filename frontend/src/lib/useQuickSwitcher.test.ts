/**
 * useQuickSwitcher tests — TDD RED phase.
 * These tests exercise the hook's exported logic: flattenTree (via note list),
 * recency-first empty-query sort, and fuzzysort-driven non-empty-query results.
 *
 * Because the hook uses useFileTree and useTreeStore (Zustand), we mock both.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// Mock useFileTree
vi.mock("./useFileTree", () => ({
  useFileTree: vi.fn(),
}));

// Mock useTreeStore — return a selector-compatible mock
vi.mock("./useTreeStore", () => ({
  useTreeStore: vi.fn(),
}));

import { useQuickSwitcher } from "./useQuickSwitcher";
import { useFileTree } from "./useFileTree";
import { useTreeStore } from "./useTreeStore";

const mockUseFileTree = useFileTree as ReturnType<typeof vi.fn>;
const mockUseTreeStore = useTreeStore as ReturnType<typeof vi.fn>;

// Helper to build a minimal Tree with NoteNodes
function makeTree(notes: Array<{ id: string; title: string; path: string }>) {
  return {
    root: notes.map((n) => ({
      kind: "note" as const,
      id: n.id,
      title: n.title,
      path: n.path,
      updated_at: "2024-01-01T00:00:00Z",
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useQuickSwitcher — empty query (recency sort)", () => {
  it("returns all notes sorted by recency when query is empty", () => {
    const notes = [
      { id: "a", title: "Alpha", path: "alpha.md" },
      { id: "b", title: "Beta", path: "beta.md" },
      { id: "c", title: "Gamma", path: "gamma.md" },
    ];
    mockUseFileTree.mockReturnValue({ tree: makeTree(notes), loading: false, error: null });
    // recentlyOpenedNoteIds: b first, then a
    mockUseTreeStore.mockReturnValue(["b", "a"]);

    const { result } = renderHook(() => useQuickSwitcher(""));
    const ids = result.current.map((h) => h.id);
    // b, a come first (recency), then c
    expect(ids[0]).toBe("b");
    expect(ids[1]).toBe("a");
    expect(ids[2]).toBe("c");
  });

  it("returns notes with no recency entry sorted by title alphabetically", () => {
    const notes = [
      { id: "z", title: "Zebra", path: "zebra.md" },
      { id: "m", title: "Mango", path: "mango.md" },
    ];
    mockUseFileTree.mockReturnValue({ tree: makeTree(notes), loading: false, error: null });
    mockUseTreeStore.mockReturnValue([]); // no recency

    const { result } = renderHook(() => useQuickSwitcher(""));
    const ids = result.current.map((h) => h.id);
    expect(ids[0]).toBe("m"); // Mango < Zebra alphabetically
    expect(ids[1]).toBe("z");
  });

  it("returns at most 50 notes", () => {
    const notes = Array.from({ length: 80 }, (_, i) => ({
      id: `note-${i}`,
      title: `Note ${i}`,
      path: `note-${i}.md`,
    }));
    mockUseFileTree.mockReturnValue({ tree: makeTree(notes), loading: false, error: null });
    mockUseTreeStore.mockReturnValue([]);

    const { result } = renderHook(() => useQuickSwitcher(""));
    expect(result.current.length).toBe(50);
  });

  it("returns empty array when tree is null", () => {
    mockUseFileTree.mockReturnValue({ tree: null, loading: true, error: null });
    mockUseTreeStore.mockReturnValue([]);

    const { result } = renderHook(() => useQuickSwitcher(""));
    expect(result.current).toEqual([]);
  });
});

describe("useQuickSwitcher — non-empty query (fuzzysort)", () => {
  it("returns matching notes for a query", () => {
    const notes = [
      { id: "a", title: "Alpha Notes", path: "alpha.md" },
      { id: "b", title: "Beta", path: "beta.md" },
      { id: "c", title: "Alphabet Soup", path: "alph.md" },
    ];
    mockUseFileTree.mockReturnValue({ tree: makeTree(notes), loading: false, error: null });
    mockUseTreeStore.mockReturnValue([]);

    const { result } = renderHook(() => useQuickSwitcher("alpha"));
    const titles = result.current.map((h) => h.title);
    // Both "Alpha Notes" and "Alphabet Soup" should match; Beta should not
    expect(titles.some((t) => t.includes("Alpha"))).toBe(true);
    expect(titles.every((t) => !t.includes("Beta"))).toBe(true);
  });

  it("applies recency tiebreaker on equal-score results", () => {
    // Two identically-named notes (edge case) — recency decides order
    const notes = [
      { id: "x", title: "Meeting Notes", path: "x.md" },
      { id: "y", title: "Meeting Notes", path: "y.md" },
    ];
    mockUseFileTree.mockReturnValue({ tree: makeTree(notes), loading: false, error: null });
    mockUseTreeStore.mockReturnValue(["y"]); // y opened more recently

    const { result } = renderHook(() => useQuickSwitcher("meeting"));
    const ids = result.current.map((h) => h.id);
    // y should come before x due to recency tiebreaker
    expect(ids[0]).toBe("y");
  });

  it("returns results with score property set", () => {
    const notes = [{ id: "a", title: "Alpha", path: "alpha.md" }];
    mockUseFileTree.mockReturnValue({ tree: makeTree(notes), loading: false, error: null });
    mockUseTreeStore.mockReturnValue([]);

    const { result } = renderHook(() => useQuickSwitcher("alp"));
    expect(result.current.length).toBeGreaterThan(0);
    expect(typeof result.current[0].score).toBe("number");
  });

  it("returns empty array when no results match", () => {
    const notes = [{ id: "a", title: "Alpha", path: "alpha.md" }];
    mockUseFileTree.mockReturnValue({ tree: makeTree(notes), loading: false, error: null });
    mockUseTreeStore.mockReturnValue([]);

    const { result } = renderHook(() => useQuickSwitcher("zzzzz"));
    expect(result.current).toHaveLength(0);
  });
});

describe("useQuickSwitcher — NoteHit shape", () => {
  it("each hit has id, title, and path", () => {
    const notes = [{ id: "n1", title: "My Note", path: "my-note.md" }];
    mockUseFileTree.mockReturnValue({ tree: makeTree(notes), loading: false, error: null });
    mockUseTreeStore.mockReturnValue([]);

    const { result } = renderHook(() => useQuickSwitcher(""));
    expect(result.current[0]).toMatchObject({ id: "n1", title: "My Note", path: "my-note.md" });
  });
});

describe("useQuickSwitcher — nested tree (folders with notes)", () => {
  it("flattens nested folder/note tree correctly", () => {
    const tree = {
      root: [
        {
          kind: "folder" as const,
          path: "work",
          name: "work",
          children: [
            {
              kind: "note" as const,
              id: "w1",
              title: "Work Note",
              path: "work/work-note.md",
              updated_at: "2024-01-01T00:00:00Z",
            },
          ],
        },
        {
          kind: "note" as const,
          id: "r1",
          title: "Root Note",
          path: "root.md",
          updated_at: "2024-01-01T00:00:00Z",
        },
      ],
    };
    mockUseFileTree.mockReturnValue({ tree, loading: false, error: null });
    mockUseTreeStore.mockReturnValue([]);

    const { result } = renderHook(() => useQuickSwitcher(""));
    const ids = result.current.map((h) => h.id);
    expect(ids).toContain("w1");
    expect(ids).toContain("r1");
  });
});

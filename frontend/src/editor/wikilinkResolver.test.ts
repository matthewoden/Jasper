/**
 * wikilinkResolver.test.ts — Unit tests for the wiki-link title resolution module.
 *
 * TDD gate: RED → GREEN
 * Test cases R1..R5 as specified in Plan 06-09 Task 1.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveWikilinkTitle, getResolvedTitlesSnapshot, setResolvedTitlesSnapshot } from "./wikilinkResolver";

// We need to mock useFileTree (a React hook) and React's useMemo for
// the hook-based tests. The pure functions (resolveWikilinkTitle,
// setResolvedTitlesSnapshot, getResolvedTitlesSnapshot) can be tested
// without React.

vi.mock("../lib/useFileTree", () => ({
  useFileTree: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Tests for the pure resolveWikilinkTitle function (R4, R5)
// ---------------------------------------------------------------------------

describe("resolveWikilinkTitle", () => {
  it("R4: returns resolved=true if the lowercase title is in the set", () => {
    const set = new Set(["foo", "bar", "baz"]);
    const result = resolveWikilinkTitle("Foo", set);
    expect(result.resolved).toBe(true);
  });

  it("R4: returns resolved=false if the title is NOT in the set", () => {
    const set = new Set(["bar", "baz"]);
    const result = resolveWikilinkTitle("Foo", set);
    expect(result.resolved).toBe(false);
    expect(result.targetId).toBeNull();
  });

  it("R5: is case-insensitive — input FOO resolves against lowercase set entry 'foo'", () => {
    const set = new Set(["foo"]);
    const result = resolveWikilinkTitle("FOO", set);
    expect(result.resolved).toBe(true);
  });

  it("R5: is case-insensitive with mixed case input", () => {
    const set = new Set(["my note title"]);
    const result = resolveWikilinkTitle("My Note Title", set);
    expect(result.resolved).toBe(true);
  });

  it("returns targetId when idMap is provided and key is present", () => {
    const set = new Set(["foo"]);
    const idMap = new Map([["foo", "uuid-1234"]]);
    const result = resolveWikilinkTitle("Foo", set, idMap);
    expect(result.resolved).toBe(true);
    expect(result.targetId).toBe("uuid-1234");
  });

  it("returns targetId=null when idMap is not provided", () => {
    const set = new Set(["foo"]);
    const result = resolveWikilinkTitle("Foo", set, null);
    expect(result.resolved).toBe(true);
    expect(result.targetId).toBeNull();
  });

  it("NFC normalizes the input title before lookup", () => {
    // precomposed "ñ" (U+00F1) vs decomposed "n" + combining-tilde (U+006E U+0303)
    const precomposed = "ñote";
    const decomposed = "ñote";
    const set = new Set([precomposed.normalize("NFC").toLowerCase()]);
    const result = resolveWikilinkTitle(decomposed, set);
    expect(result.resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests for module-level snapshot setters/getters
// ---------------------------------------------------------------------------

describe("setResolvedTitlesSnapshot / getResolvedTitlesSnapshot", () => {
  it("getResolvedTitlesSnapshot returns the set that was passed to setResolvedTitlesSnapshot", () => {
    const set = new Set(["alpha", "beta"]);
    setResolvedTitlesSnapshot(set);
    const { titles } = getResolvedTitlesSnapshot();
    expect(titles).toBe(set);
  });

  it("idMap defaults to null when not provided", () => {
    setResolvedTitlesSnapshot(new Set(["alpha"]));
    const { idMap } = getResolvedTitlesSnapshot();
    expect(idMap).toBeNull();
  });

  it("stores idMap when provided", () => {
    const set = new Set(["alpha"]);
    const idMap = new Map([["alpha", "uuid-alpha"]]);
    setResolvedTitlesSnapshot(set, idMap);
    const { titles, idMap: storedMap } = getResolvedTitlesSnapshot();
    expect(titles).toBe(set);
    expect(storedMap).toBe(idMap);
  });
});

// ---------------------------------------------------------------------------
// Tests for useResolvedTitleSet hook (R1, R2, R3)
// These tests mock useFileTree and renderHook to test the hook logic.
// ---------------------------------------------------------------------------

import { renderHook } from "@testing-library/react";
import { useResolvedTitleSet } from "./wikilinkResolver";
import { useFileTree } from "../lib/useFileTree";

const mockUseFileTree = vi.mocked(useFileTree);

describe("useResolvedTitleSet", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("R3: empty tree returns empty Set", () => {
    mockUseFileTree.mockReturnValue({
      tree: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
      mutate: vi.fn(),
    });
    const { result } = renderHook(() => useResolvedTitleSet());
    expect(result.current.titleSet.size).toBe(0);
    expect(result.current.idMap.size).toBe(0);
  });

  it("R3: tree with empty root returns empty Set", () => {
    mockUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: vi.fn(),
      mutate: vi.fn(),
    });
    const { result } = renderHook(() => useResolvedTitleSet());
    expect(result.current.titleSet.size).toBe(0);
  });

  it("R1: tree with 3 notes returns Set with 3 lowercase titles", () => {
    mockUseFileTree.mockReturnValue({
      tree: {
        root: [
          { kind: "note", id: "id-1", path: "Alpha.md", title: "Alpha", updated_at: "" },
          { kind: "note", id: "id-2", path: "Beta.md", title: "Beta", updated_at: "" },
          { kind: "note", id: "id-3", path: "Gamma.md", title: "Gamma", updated_at: "" },
        ],
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
      mutate: vi.fn(),
    });
    const { result } = renderHook(() => useResolvedTitleSet());
    expect(result.current.titleSet.size).toBe(3);
    expect(result.current.titleSet.has("alpha")).toBe(true);
    expect(result.current.titleSet.has("beta")).toBe(true);
    expect(result.current.titleSet.has("gamma")).toBe(true);
  });

  it("R1: idMap is also populated from notes in tree", () => {
    mockUseFileTree.mockReturnValue({
      tree: {
        root: [
          { kind: "note", id: "uuid-1", path: "Foo.md", title: "Foo", updated_at: "" },
        ],
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
      mutate: vi.fn(),
    });
    const { result } = renderHook(() => useResolvedTitleSet());
    expect(result.current.idMap.get("foo")).toBe("uuid-1");
  });

  it("R1: notes inside folders are included", () => {
    mockUseFileTree.mockReturnValue({
      tree: {
        root: [
          {
            kind: "folder",
            path: "docs",
            name: "docs",
            children: [
              { kind: "note", id: "id-nested", path: "docs/Nested.md", title: "Nested", updated_at: "" },
            ],
          },
          { kind: "note", id: "id-root", path: "Root.md", title: "Root", updated_at: "" },
        ],
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
      mutate: vi.fn(),
    });
    const { result } = renderHook(() => useResolvedTitleSet());
    expect(result.current.titleSet.has("nested")).toBe(true);
    expect(result.current.titleSet.has("root")).toBe(true);
  });

  it("R2: memoized — same tree object returns same Set identity", () => {
    const tree = {
      root: [
        { kind: "note" as const, id: "id-1", path: "A.md", title: "A", updated_at: "" },
      ],
    };
    mockUseFileTree.mockReturnValue({
      tree,
      loading: false,
      error: null,
      refresh: vi.fn(),
      mutate: vi.fn(),
    });
    const { result, rerender } = renderHook(() => useResolvedTitleSet());
    const firstSet = result.current.titleSet;
    rerender();
    expect(result.current.titleSet).toBe(firstSet); // identity preserved (memoized)
  });

  it("R2: tree identity change triggers new Set", () => {
    const tree1 = {
      root: [{ kind: "note" as const, id: "id-1", path: "A.md", title: "A", updated_at: "" }],
    };
    const tree2 = {
      root: [
        { kind: "note" as const, id: "id-1", path: "A.md", title: "A", updated_at: "" },
        { kind: "note" as const, id: "id-2", path: "B.md", title: "B", updated_at: "" },
      ],
    };
    mockUseFileTree.mockReturnValue({
      tree: tree1,
      loading: false,
      error: null,
      refresh: vi.fn(),
      mutate: vi.fn(),
    });
    const { result, rerender } = renderHook(() => useResolvedTitleSet());
    const firstSet = result.current.titleSet;
    expect(firstSet.size).toBe(1);

    // Update to tree2 (new object identity — same as a WS-triggered refresh)
    mockUseFileTree.mockReturnValue({
      tree: tree2,
      loading: false,
      error: null,
      refresh: vi.fn(),
      mutate: vi.fn(),
    });
    rerender();
    expect(result.current.titleSet.size).toBe(2);
    expect(result.current.titleSet).not.toBe(firstSet); // new Set identity
  });
});

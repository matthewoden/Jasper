/**
 * fileTree.utils.test.ts — sortTree folder-grouping comparator (SORT-01).
 * Covers the six sort orders + nested recursion + tie-break behavior.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ancestorFolderPaths,
  expandNoteAncestorFolders,
  setCurrentTreeRef,
  sortTree,
  type ArboristNode,
} from "./fileTree.utils";
import { useTreeStore } from "../lib/useTreeStore";
import type { TreeApi } from "react-arborist";

function folder(name: string, children: ArboristNode[] = []): ArboristNode {
  return {
    id: "folder:" + name,
    name,
    data: { kind: "folder", path: name, name },
    children,
  };
}

function note(
  name: string,
  opts: { updated_at?: string; created?: string } = {},
): ArboristNode {
  return {
    id: "note:" + name,
    name,
    data: {
      kind: "note",
      id: name,
      path: name + ".md",
      title: name,
      updated_at: opts.updated_at,
      created: opts.created,
    },
  };
}

describe("sortTree", () => {
  it("name-asc: folders A→Z first, then notes A→Z", () => {
    const nodes = [
      note("Charlie"),
      folder("Zebra"),
      note("Alpha"),
      folder("Apple"),
    ];
    const sorted = sortTree(nodes, "name-asc");
    expect(sorted.map((n) => n.name)).toEqual([
      "Apple",
      "Zebra",
      "Alpha",
      "Charlie",
    ]);
  });

  it("name-desc: folders STILL A→Z first, notes Z→A", () => {
    const nodes = [note("Alpha"), folder("Zebra"), note("Charlie"), folder("Apple")];
    const sorted = sortTree(nodes, "name-desc");
    expect(sorted.map((n) => n.name)).toEqual([
      "Apple",
      "Zebra",
      "Charlie",
      "Alpha",
    ]);
  });

  it("modified-desc: folders A→Z first, notes newest-modified first", () => {
    const nodes = [
      note("Old", { updated_at: "2026-01-01T00:00:00Z" }),
      folder("Zebra"),
      note("New", { updated_at: "2026-06-01T00:00:00Z" }),
      folder("Apple"),
    ];
    const sorted = sortTree(nodes, "modified-desc");
    expect(sorted.map((n) => n.name)).toEqual([
      "Apple",
      "Zebra",
      "New",
      "Old",
    ]);
  });

  it("modified-asc: notes oldest-modified first", () => {
    const nodes = [
      note("New", { updated_at: "2026-06-01T00:00:00Z" }),
      note("Old", { updated_at: "2026-01-01T00:00:00Z" }),
    ];
    const sorted = sortTree(nodes, "modified-asc");
    expect(sorted.map((n) => n.name)).toEqual(["Old", "New"]);
  });

  it("created-desc: folders A→Z first, notes newest-created first (reads node `created`)", () => {
    const nodes = [
      note("OldCreated", { created: "2025-01-01T00:00:00Z" }),
      folder("Zebra"),
      note("NewCreated", { created: "2026-06-01T00:00:00Z" }),
      folder("Apple"),
    ];
    const sorted = sortTree(nodes, "created-desc");
    expect(sorted.map((n) => n.name)).toEqual([
      "Apple",
      "Zebra",
      "NewCreated",
      "OldCreated",
    ]);
  });

  it("created-asc: notes oldest-created first", () => {
    const nodes = [
      note("NewCreated", { created: "2026-06-01T00:00:00Z" }),
      note("OldCreated", { created: "2025-01-01T00:00:00Z" }),
    ];
    const sorted = sortTree(nodes, "created-asc");
    expect(sorted.map((n) => n.name)).toEqual(["OldCreated", "NewCreated"]);
  });

  it("recurses: a nested folder's children are sorted by the same order", () => {
    const nested = folder("Parent", [
      note("Zeta"),
      folder("NestedZ"),
      note("Alpha"),
      folder("NestedA"),
    ]);
    const sorted = sortTree([nested], "name-asc");
    expect(sorted).toHaveLength(1);
    const children = sorted[0].children ?? [];
    expect(children.map((n) => n.name)).toEqual([
      "NestedA",
      "NestedZ",
      "Alpha",
      "Zeta",
    ]);
  });

  it("ties (equal timestamps) fall back to name A→Z for stable ordering", () => {
    const nodes = [
      note("Bravo", { updated_at: "2026-01-01T00:00:00Z" }),
      note("Alpha", { updated_at: "2026-01-01T00:00:00Z" }),
    ];
    const sorted = sortTree(nodes, "modified-desc");
    expect(sorted.map((n) => n.name)).toEqual(["Alpha", "Bravo"]);
  });
});

describe("ancestorFolderPaths", () => {
  it("returns the single containing folder for a top-level daily note", () => {
    expect(ancestorFolderPaths("daily/2026-07-30.md")).toEqual(["daily"]);
  });

  it("returns cumulative prefixes outermost-first for a nested note", () => {
    expect(ancestorFolderPaths("a/b/c/note.md")).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("returns an empty array for a root-level note", () => {
    expect(ancestorFolderPaths("note.md")).toEqual([]);
  });
});

describe("expandNoteAncestorFolders", () => {
  afterEach(() => {
    setCurrentTreeRef(null);
    useTreeStore.setState({ expanded: new Set() });
  });

  it("opens the TreeApi and writes the store for each ancestor folder", () => {
    const open = vi.fn();
    setCurrentTreeRef(
      { open, isOpen: () => false } as unknown as TreeApi<ArboristNode>,
    );

    expandNoteAncestorFolders("daily/2026-07-30.md");

    expect(open).toHaveBeenCalledWith("folder:daily");
    expect(useTreeStore.getState().expanded.has("daily")).toBe(true);
  });
});

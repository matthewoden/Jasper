/**
 * Tests for treeNoteLookup — the single shared "note id -> containing folder
 * path" primitive (D-06). Covers nested-folder resolution, the vault-root
 * fallback, and the null/unknown-id edge cases the switcher-create flow
 * (Plan 05) depends on.
 */
import { describe, expect, it } from "vitest";

import type { TreeNode } from "./treeApi";
import { findNotePath, getNoteFolder, parentDir } from "./treeNoteLookup";

const ROOT_NOTE: TreeNode = {
  kind: "note",
  id: "root-note-id",
  path: "root-note.md",
  title: "root-note",
  updated_at: "2026-01-01T00:00:00Z",
};

const NESTED_NOTE: TreeNode = {
  kind: "note",
  id: "nested-note-id",
  path: "a/b/note.md",
  title: "note",
  updated_at: "2026-01-01T00:00:00Z",
};

const TREE: TreeNode[] = [
  ROOT_NOTE,
  {
    kind: "folder",
    path: "a",
    name: "a",
    children: [
      {
        kind: "folder",
        path: "a/b",
        name: "b",
        children: [NESTED_NOTE],
      },
    ],
  },
];

describe("parentDir", () => {
  it("returns the folder portion of a nested path", () => {
    expect(parentDir("a/b/note.md")).toBe("a/b");
  });

  it("returns '' for a root-level path", () => {
    expect(parentDir("note.md")).toBe("");
  });
});

describe("findNotePath", () => {
  it("finds a note nested multiple levels deep", () => {
    expect(findNotePath(TREE, "nested-note-id")).toBe("a/b/note.md");
  });

  it("finds a root-level note", () => {
    expect(findNotePath(TREE, "root-note-id")).toBe("root-note.md");
  });

  it("returns null for an unknown id", () => {
    expect(findNotePath(TREE, "does-not-exist")).toBeNull();
  });
});

describe("getNoteFolder", () => {
  it("resolves the containing folder for a multi-level nested note", () => {
    expect(getNoteFolder("nested-note-id", TREE)).toBe("a/b");
  });

  it("returns '' (vault root) for a root-level note", () => {
    expect(getNoteFolder("root-note-id", TREE)).toBe("");
  });

  it("returns '' when noteId is null", () => {
    expect(getNoteFolder(null, TREE)).toBe("");
  });

  it("returns '' for an unknown id", () => {
    expect(getNoteFolder("does-not-exist", TREE)).toBe("");
  });
});

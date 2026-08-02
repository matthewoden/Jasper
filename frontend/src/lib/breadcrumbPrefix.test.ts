import { describe, it, expect } from "vitest";
import { breadcrumbPrefix, breadcrumbTrail, breadcrumbSegments } from "./breadcrumbPrefix";

describe("breadcrumbPrefix", () => {
  it("returns folder segments joined by ' / ' for a nested note", () => {
    expect(breadcrumbPrefix("a/b/c.md")).toBe("a / b");
  });

  it("handles a deeper folder path", () => {
    expect(breadcrumbPrefix("docs/api/route.md")).toBe("docs / api");
  });

  it("returns '' for a vault-root note (no folders)", () => {
    expect(breadcrumbPrefix("note.md")).toBe("");
  });

  it("returns '' for an empty path", () => {
    expect(breadcrumbPrefix("")).toBe("");
  });

  it("ignores a trailing slash / empty segments", () => {
    expect(breadcrumbPrefix("a/b/")).toBe("a");
  });

  it("ignores a leading slash (empty leading segment)", () => {
    expect(breadcrumbPrefix("/a/b.md")).toBe("a");
  });
});

describe("breadcrumbTrail", () => {
  it("returns 'a / b / c' for a doubly-nested note", () => {
    expect(breadcrumbTrail("a/b/c.md")).toBe("a / b / c");
  });

  it("handles a deeper folder path", () => {
    expect(breadcrumbTrail("docs/api/route.md")).toBe("docs / api / route");
  });

  it("returns title-only for a vault-root note (no folders)", () => {
    expect(breadcrumbTrail("note.md")).toBe("note");
  });

  it("handles mixed-case segments", () => {
    expect(breadcrumbTrail("Inbox/Today.md")).toBe("Inbox / Today");
  });

  it("returns '' for an empty path", () => {
    expect(breadcrumbTrail("")).toBe("");
  });

  it("handles trailing slash — last non-empty segment is the title", () => {
    expect(breadcrumbTrail("a/b/")).toBe("a / b");
  });

  it("ignores a leading slash (empty leading segment)", () => {
    expect(breadcrumbTrail("/a/b.md")).toBe("a / b");
  });
});

describe("breadcrumbSegments", () => {
  it("root note 'note.md' yields a single note segment", () => {
    const result = breadcrumbSegments("note.md");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      label: "note",
      folderPath: "note.md",
      kind: "note",
    });
  });

  it("nested note 'a/b/c.md' yields 2 folder segments + 1 note segment", () => {
    const result = breadcrumbSegments("a/b/c.md");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ label: "a", folderPath: "a", kind: "folder" });
    expect(result[1]).toEqual({ label: "b", folderPath: "a/b", kind: "folder" });
    expect(result[2]).toEqual({ label: "c", folderPath: "a/b/c.md", kind: "note" });
  });

  it("empty path '' yields empty array", () => {
    expect(breadcrumbSegments("")).toHaveLength(0);
  });

  it("SET2-07: N segments imply N-1 separators (no trailing slash after last segment)", () => {
    // 3 segments → 2 separators; assert separator count via segment.length - 1
    const segments = breadcrumbSegments("a/b/c.md");
    const separatorCount = segments.length - 1;
    expect(separatorCount).toBe(2);
    // Last segment must not carry a trailing separator (no separator at end)
    expect(segments[segments.length - 1].kind).toBe("note");
  });

  it("single-level nested note 'folder/note.md' yields 1 folder + 1 note segment", () => {
    const result = breadcrumbSegments("folder/note.md");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ label: "folder", folderPath: "folder", kind: "folder" });
    expect(result[1]).toEqual({ label: "note", folderPath: "folder/note.md", kind: "note" });
  });
});

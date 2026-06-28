import { describe, it, expect } from "vitest";
import { breadcrumbPrefix, breadcrumbTrail } from "./breadcrumbPrefix";

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

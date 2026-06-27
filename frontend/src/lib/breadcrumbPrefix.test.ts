import { describe, it, expect } from "vitest";
import { breadcrumbPrefix } from "./breadcrumbPrefix";

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

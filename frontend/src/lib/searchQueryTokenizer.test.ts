import { describe, it, expect } from "vitest";
import { parseSearchQuery } from "./searchQueryTokenizer";

describe("parseSearchQuery", () => {
  it("returns free text with no tags when there is no tag: term", () => {
    expect(parseSearchQuery("budget")).toEqual({ tags: [], text: "budget" });
  });

  it("extracts a single tag: term from free text", () => {
    expect(parseSearchQuery("tag:work budget")).toEqual({
      tags: ["work"],
      text: "budget",
    });
  });

  it("accumulates multiple tag: terms", () => {
    expect(parseSearchQuery("tag:work tag:draft budget report")).toEqual({
      tags: ["work", "draft"],
      text: "budget report",
    });
  });

  it("handles a tag-only query with no free text", () => {
    expect(parseSearchQuery("tag:work")).toEqual({ tags: ["work"], text: "" });
  });

  it("handles an empty query", () => {
    expect(parseSearchQuery("")).toEqual({ tags: [], text: "" });
  });

  it("drops a bare tag: with no name", () => {
    expect(parseSearchQuery("tag: budget")).toEqual({
      tags: [],
      text: "budget",
    });
  });

  it("collapses extra internal whitespace", () => {
    expect(parseSearchQuery("  tag:work   budget  ")).toEqual({
      tags: ["work"],
      text: "budget",
    });
  });

  it("de-duplicates repeated tags", () => {
    expect(parseSearchQuery("tag:work tag:work x")).toEqual({
      tags: ["work"],
      text: "x",
    });
  });
});

/**
 * Auto-increment must be case-insensitive, matching the server's canonical
 * collision rule, and must FILL sparse gaps — ["untitled", "untitled 2"] yields
 * "untitled 1", as Finder and VS Code do.
 */
import { describe, expect, it } from "vitest";

import { nextUntitledName } from "./nextUntitledName";

describe("nextUntitledName", () => {
  it("C1: empty list returns base", () => {
    expect(nextUntitledName([], "untitled")).toBe("untitled");
  });

  it("C2: base taken returns base 1", () => {
    expect(nextUntitledName(["untitled"], "untitled")).toBe("untitled 1");
  });

  it("C3: base + base 1 taken returns base 2", () => {
    expect(nextUntitledName(["untitled", "untitled 1"], "untitled")).toBe(
      "untitled 2",
    );
  });

  it("C4: case-insensitive collision on the base name", () => {
    expect(nextUntitledName(["UNTITLED"], "untitled")).toBe("untitled 1");
  });

  it("C5: case-insensitive on numbered variants too", () => {
    expect(
      nextUntitledName(["Untitled", "untitled 1", "UNTITLED 2"], "untitled"),
    ).toBe("untitled 3");
  });

  it("C6: sparse gaps ARE filled — sequential allocation picks lowest hole", () => {
    expect(nextUntitledName(["untitled", "untitled 2"], "untitled")).toBe(
      "untitled 1",
    );
  });

  it("C7: unrelated names are ignored", () => {
    expect(nextUntitledName(["foo", "bar"], "untitled")).toBe("untitled");
  });

  it("C8: base substring is not a match — only exact + numbered count", () => {
    expect(nextUntitledName(["untitled-things"], "untitled")).toBe("untitled");
  });

  it("C9: custom base — different word", () => {
    expect(
      nextUntitledName(["new-folder", "new-folder 1"], "new-folder"),
    ).toBe("new-folder 2");
  });
});

import { describe, it, expect } from "vitest";
import { shouldPromoteActiveNote } from "./promoteActiveNote";

describe("shouldPromoteActiveNote", () => {
  const notes = new Set(["a", "b", "c"]);

  it("zero tabs + live active id → true", () => {
    expect(shouldPromoteActiveNote(0, "a", notes)).toBe(true);
  });

  it("non-zero tabs → false (persisted tabs win)", () => {
    expect(shouldPromoteActiveNote(1, "a", notes)).toBe(false);
    expect(shouldPromoteActiveNote(3, "a", notes)).toBe(false);
  });

  it("null active id → false", () => {
    expect(shouldPromoteActiveNote(0, null, notes)).toBe(false);
  });

  it("active id not in the tree → false", () => {
    expect(shouldPromoteActiveNote(0, "missing", notes)).toBe(false);
  });

  it("zero tabs but empty tree → false", () => {
    expect(shouldPromoteActiveNote(0, "a", new Set())).toBe(false);
  });
});

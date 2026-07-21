import { describe, it, expect } from "vitest";
import { sortTagsByCountDesc } from "./tagSort";

describe("sortTagsByCountDesc", () => {
  it("orders items by count descending", () => {
    const result = sortTagsByCountDesc([
      { name: "a", count: 1 },
      { name: "b", count: 3 },
      { name: "c", count: 2 },
    ]);
    expect(result.map((t) => t.name)).toEqual(["b", "c", "a"]);
  });

  it("breaks ties alphabetically", () => {
    const result = sortTagsByCountDesc([
      { name: "b", count: 1 },
      { name: "a", count: 1 },
    ]);
    expect(result.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      { name: "b", count: 1 },
      { name: "a", count: 2 },
    ];
    const original = [...input];
    sortTagsByCountDesc(input);
    expect(input).toEqual(original);
  });
});

import { describe, expect, it } from "vitest";

import { countWords, formatWordCount } from "./wordCount";

describe("countWords", () => {
  it("returns 0 for empty content", () => {
    expect(countWords("")).toBe(0);
  });

  it("counts simple words", () => {
    expect(countWords("hello world")).toBe(2);
  });

  it("excludes frontmatter from the count", () => {
    expect(
      countWords("---\ntitle: Note\ntags: [a, b]\n---\nhello world"),
    ).toBe(2);
  });

  it("includes code-block content (D-08)", () => {
    expect(countWords("```\nconst x = 1\n```")).toBe(3);
  });

  it("does not count markdown punctuation as words", () => {
    expect(countWords("# Heading\n\n- item one\n---")).toBe(3);
  });

  it("returns 0 for frontmatter-only content with no body", () => {
    expect(countWords("---\ntitle: x\n---\n")).toBe(0);
  });
});

describe("formatWordCount", () => {
  it("formats 0 as '0 words'", () => {
    expect(formatWordCount(0)).toBe("0 words");
  });

  it("formats 1 as singular '1 word'", () => {
    expect(formatWordCount(1)).toBe("1 word");
  });

  it("formats 2 as '2 words'", () => {
    expect(formatWordCount(2)).toBe("2 words");
  });

  it("formats 1234 with a thousands separator (D-09)", () => {
    expect(formatWordCount(1234)).toBe("1,234 words");
  });
});

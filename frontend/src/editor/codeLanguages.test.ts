/**
 * codeLanguages.test — verifies each declared language resolves
 * a LanguageSupport instance without throwing. Plan 05-07 / EDIT-08.
 */
import { describe, it, expect } from "vitest";
import { LanguageSupport } from "@codemirror/language";
import { codeLanguages } from "./codeLanguages";

describe("codeLanguages", () => {
  it("declares the D-03 bundled grammar set (10 entries — including markdown for recursive nesting)", () => {
    const names = codeLanguages.map((l) => l.name);
    expect(names).toContain("javascript");
    expect(names).toContain("typescript");
    expect(names).toContain("python");
    expect(names).toContain("go");
    expect(names).toContain("html");
    expect(names).toContain("css");
    expect(names).toContain("json");
    expect(names).toContain("yaml");
    expect(names).toContain("markdown");
    expect(names).toContain("shell");
  });

  it("each entry's load() resolves a LanguageSupport without throwing", async () => {
    for (const desc of codeLanguages) {
      const support = await desc.load();
      expect(support).toBeInstanceOf(LanguageSupport);
    }
  });

  it("'ts' alias resolves to the typescript description", () => {
    const ts = LanguageDescriptionMatch(codeLanguages, "ts");
    expect(ts?.name).toBe("typescript");
  });

  it("'bash' alias resolves to the shell description", () => {
    const sh = LanguageDescriptionMatch(codeLanguages, "bash");
    expect(sh?.name).toBe("shell");
  });

  it("unknown language returns undefined (CM6 default-fall-through)", () => {
    const unknown = LanguageDescriptionMatch(codeLanguages, "rust-analyzer-7");
    expect(unknown).toBeUndefined();
  });
});


function LanguageDescriptionMatch(
  langs: typeof codeLanguages,
  key: string
) {
  const lower = key.toLowerCase();
  return langs.find(
    (l) => l.name.toLowerCase() === lower || l.alias?.includes(lower)
  );
}

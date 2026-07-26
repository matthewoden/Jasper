import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./defaults";
import { SECTIONS, type SectionId } from "./sections";

describe("DEFAULT_CONFIG", () => {
  it("mirrors the editor defaults from backend/internal/config/defaults.go", () => {
    expect(DEFAULT_CONFIG.editor.fontSize).toBe(15);
    expect(DEFAULT_CONFIG.editor.lineWidth).toBe(700);
  });

  it("mirrors the templates default folder", () => {
    expect(DEFAULT_CONFIG.templates.folder).toBe("Templates");
  });

  it("never carries server.port or server.dataDir — a Reset must not touch them", () => {
    expect("port" in DEFAULT_CONFIG.server).toBe(false);
    expect("dataDir" in DEFAULT_CONFIG.server).toBe(false);
  });
});

describe("SECTIONS", () => {
  it("has exactly five entries, with templates absent this phase", () => {
    expect(SECTIONS).toHaveLength(5);
    expect(SECTIONS.some((s) => s.id === "templates")).toBe(false);
  });

  it("gives About no Reset button", () => {
    expect(SECTIONS.find((s) => s.id === "about")?.hasReset).toBe(false);
  });

  it("types SectionId to accept the hidden sixth section", () => {
    const hiddenSection: SectionId = "templates";
    expect(hiddenSection).toBe("templates");
  });
});

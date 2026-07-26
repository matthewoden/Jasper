import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./defaults";
import { SECTIONS, isResettable, type ResettableSectionId, type SectionId } from "./sections";

describe("DEFAULT_CONFIG", () => {
  it("mirrors the editor defaults from backend/internal/config/defaults.go", () => {
    expect(DEFAULT_CONFIG.editor.fontSize).toBe(15);
    expect(DEFAULT_CONFIG.editor.lineWidth).toBe(700);
  });

  it("mirrors the templates default folder", () => {
    expect(DEFAULT_CONFIG.templates.folder).toBe("Templates");
  });

  // ORPHANED 2026-07-26 (ADR-002 v2): no production code reads
  // DEFAULT_CONFIG.server since buildResetPatch's `case "server"` was
  // deleted, so this guards a shape nothing consumes. Parked alongside the
  // field itself for Phase 36's Server pane rather than deleted, so the
  // constraint it encodes is not silently lost.
  describe("server (parked for Phase 36)", () => {
    it("never carries server.port or server.dataDir — a Reset must not touch them", () => {
      expect("port" in DEFAULT_CONFIG.server).toBe(false);
      expect("dataDir" in DEFAULT_CONFIG.server).toBe(false);
    });
  });
});

describe("SECTIONS", () => {
  it("has exactly four entries, with templates and server absent this phase", () => {
    const ids: SectionId[] = SECTIONS.map((s) => s.id);
    expect(ids).toHaveLength(4);
    expect(ids).not.toContain("templates");
    expect(ids).not.toContain("server");
  });

  it("types SectionId to accept both hidden ids (templates, server)", () => {
    // Type-level only: the runtime half would be tautological. If either id
    // is dropped from SectionId, `tsc` fails here.
    const hidden = ["templates", "server"] as const satisfies readonly SectionId[];
    expect(hidden).toHaveLength(2);
  });
});

describe("isResettable", () => {
  it("gives About no Reset button", () => {
    expect(isResettable("about")).toBe(false);
  });

  it("marks exactly the three panes with a buildResetPatch case", () => {
    const resettable: ResettableSectionId[] = ["appearance", "editor", "dailyNotes"];
    for (const id of resettable) expect(isResettable(id)).toBe(true);
    expect(SECTIONS.filter((s) => isResettable(s.id))).toHaveLength(resettable.length);
  });

  it("rejects the sections that are not rendered this phase", () => {
    expect(isResettable("templates")).toBe(false);
    expect(isResettable("server")).toBe(false);
  });
});

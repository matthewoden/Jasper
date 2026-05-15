import { describe, it, expect } from "vitest";
import {
  SHORTCUTS_REGISTRY,
  COMMAND_PALETTE_ENTRIES,
  CHEAT_SHEET_ENTRIES,
  GROUP_ORDER,
} from "./shortcutsRegistry";

describe("shortcutsRegistry", () => {
  it("registry has all 8 locked Cmd+P palette entries (D-14; Plan 07-27 removed Find)", () => {
    const labels = COMMAND_PALETTE_ENTRIES.map((s) => s.label);
    expect(labels).toContain("New note");
    expect(labels).toContain("Save");
    // "Find in note" removed in Plan 07-27 — browser native Cmd+F fires instead
    expect(labels).not.toContain("Find in note");
    expect(labels).toContain("Today");
    expect(labels).toContain("Switch / search notes");
    expect(labels).toContain("Toggle theme");
    expect(labels).toContain("Refresh index");
    expect(labels).toContain("Reset and rebuild…");
    expect(labels).toContain("Show keyboard shortcuts");
    expect(COMMAND_PALETTE_ENTRIES.length).toBe(8);
  });

  it("cheat-sheet contains CM6 built-in editor entries", () => {
    const labels = CHEAT_SHEET_ENTRIES.map((s) => s.label);
    expect(labels).toContain("Bold");
    expect(labels).toContain("Italic");
    expect(labels).toContain("Toggle raw frontmatter view");
  });

  it("cheat-sheet excludes Index group entries (RefreshIndex / RebuildIndex are palette-only per registry)", () => {
    const labels = CHEAT_SHEET_ENTRIES.map((s) => s.label);
    expect(labels).not.toContain("Refresh index");
    expect(labels).not.toContain("Reset and rebuild…");
  });

  it("group order is locked", () => {
    expect(GROUP_ORDER).toEqual(["File", "Editor", "Navigation", "View", "Index", "Help"]);
  });

  it("every shortcut entry has a stable id and either shortcut or palette-only flag", () => {
    for (const entry of SHORTCUTS_REGISTRY) {
      expect(entry.id).toBeTruthy();
      expect(entry.label).toBeTruthy();
      // Must have at least one display purpose
      expect(entry.inPalette || entry.inCheatSheet).toBe(true);
    }
  });

  it("ids are unique", () => {
    const ids = SHORTCUTS_REGISTRY.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// Plan 07-27 / UAT-2 N6 RED: shortcutsRegistry does NOT include 'find' after Plan 07-27
describe("Plan 07-27 — Cmd+F removal (UAT-2 N6)", () => {
  it("SR-no-find — shortcutsRegistry does NOT include 'find' after Plan 07-27", () => {
    const found = SHORTCUTS_REGISTRY.find((s) => s.id === "find");
    expect(found).toBeUndefined();
  });

  it("SR-palette-count — COMMAND_PALETTE_ENTRIES has 8 entries (not 9) after Find removal", () => {
    expect(COMMAND_PALETTE_ENTRIES.length).toBe(8);
  });
});

// Plan 07-27 / UAT-2 N7: shortcutsRegistry includes 'underline' (Cmd+U) in cheat-sheet
describe("Plan 07-27 — Cmd+U underline (UAT-2 N7)", () => {
  it("SR-underline — shortcutsRegistry includes 'underline' entry with inCheatSheet: true", () => {
    const entry = SHORTCUTS_REGISTRY.find((s) => s.id === "underline");
    expect(entry).toBeDefined();
    expect(entry?.inCheatSheet).toBe(true);
    expect(entry?.inPalette).toBe(false);
    expect(entry?.group).toBe("Editor");
  });
});

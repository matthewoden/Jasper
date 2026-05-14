import { describe, it, expect } from "vitest";
import {
  SHORTCUTS_REGISTRY,
  COMMAND_PALETTE_ENTRIES,
  CHEAT_SHEET_ENTRIES,
  GROUP_ORDER,
} from "./shortcutsRegistry";

describe("shortcutsRegistry", () => {
  it("registry has all 9 locked Cmd+P palette entries (D-14)", () => {
    const labels = COMMAND_PALETTE_ENTRIES.map((s) => s.label);
    expect(labels).toContain("New note");
    expect(labels).toContain("Save");
    expect(labels).toContain("Find in note");
    expect(labels).toContain("Today");
    expect(labels).toContain("Switch note…");
    expect(labels).toContain("Toggle theme");
    expect(labels).toContain("Refresh index");
    expect(labels).toContain("Reset and rebuild…");
    expect(labels).toContain("Show keyboard shortcuts");
    expect(COMMAND_PALETTE_ENTRIES.length).toBe(9);
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

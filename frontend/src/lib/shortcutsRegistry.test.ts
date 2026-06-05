import { describe, it, expect } from "vitest";
import {
  SHORTCUTS_REGISTRY,
  COMMAND_PALETTE_ENTRIES,
  CHEAT_SHEET_ENTRIES,
  GROUP_ORDER,
} from "./shortcutsRegistry";

describe("shortcutsRegistry", () => {
  it("registry has all 10 locked Cmd+P palette entries (Plan 08-06 added Share/Reveal; Plan 08-17c added Switch vault)", () => {
    const labels = COMMAND_PALETTE_ENTRIES.map((s) => s.label);
    expect(labels).toContain("New note");
    expect(labels).toContain("Save");
    expect(labels).not.toContain("Find in note");
    expect(labels).toContain("Today");
    expect(labels).toContain("Switch / search notes");
    expect(labels).toContain("Toggle theme");
    expect(labels).toContain("Refresh index");
    expect(labels).toContain("Reset and rebuild…");
    expect(labels).toContain("Show keyboard shortcuts");
    expect(labels).toContain("Show current note in file manager");
    expect(labels).toContain("Switch vault…");
    expect(COMMAND_PALETTE_ENTRIES.length).toBe(10);
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
    expect(GROUP_ORDER).toEqual([
      "File",
      "Editor",
      "Navigation",
      "Sidebar",
      "Palette",
      "View",
      "Share",
      "Index",
      "Help",
      "Vault",
    ]);
  });

  it("every shortcut entry has a stable id and either shortcut or palette-only flag", () => {
    for (const entry of SHORTCUTS_REGISTRY) {
      expect(entry.id).toBeTruthy();
      expect(entry.label).toBeTruthy();
      expect(entry.inPalette || entry.inCheatSheet).toBe(true);
    }
  });

  it("ids are unique", () => {
    const ids = SHORTCUTS_REGISTRY.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});


describe("Plan 07-27 — Cmd+F removal (UAT-2 N6)", () => {
  it("SR-no-find — shortcutsRegistry does NOT include 'find' after Plan 07-27", () => {
    const found = SHORTCUTS_REGISTRY.find((s) => s.id === "find");
    expect(found).toBeUndefined();
  });

  it("SR-palette-count — COMMAND_PALETTE_ENTRIES has 10 entries (Plan 08-06 added Share/Reveal; Plan 08-17c added Switch vault; Find still removed)", () => {
    expect(COMMAND_PALETTE_ENTRIES.length).toBe(10);
  });
});


describe("Plan 07-36 — Cmd+U underline removed (UAT-3 N7)", () => {
  it("SR-no-underline — shortcutsRegistry does NOT include 'underline' entry", () => {
    const entry = SHORTCUTS_REGISTRY.find((s) => s.id === "underline");
    expect(entry).toBeUndefined();
  });
});

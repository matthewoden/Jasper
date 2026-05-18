import { describe, it, expect } from "vitest";
import {
  SHORTCUTS_REGISTRY,
  COMMAND_PALETTE_ENTRIES,
  CHEAT_SHEET_ENTRIES,
  GROUP_ORDER,
} from "./shortcutsRegistry";

describe("shortcutsRegistry", () => {
  it("registry has all 9 locked Cmd+P palette entries (Plan 08-06 added Share/Reveal)", () => {
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
    // Plan 08-06 (D-26 / SHARE-01 Mount C) — new "Share" group entry.
    expect(labels).toContain("Show current note in file manager");
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
    // Plan 07-39 (UAT-5 N11): added "Sidebar" group between Navigation and View.
    // Plan 07-40 (UAT-6): added "Palette" group after "Sidebar" to host
    // the focus-search Cmd+Shift+F entry now that search is a modal.
    // Plan 08-06 (UI-SPEC §Surface 4 Mount C): added "Share" between
    // "View" and "Index" for the reveal command.
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
    ]);
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

  it("SR-palette-count — COMMAND_PALETTE_ENTRIES has 9 entries (Plan 08-06 added Share/Reveal; Find still removed)", () => {
    // Plan 07-27 (UAT-2 N6) removed "Find in note" → 8 entries.
    // Plan 08-06 (D-26 / SHARE-01 Mount C) added the share-reveal command
    // → 9 entries. This assertion bakes both deltas in.
    expect(COMMAND_PALETTE_ENTRIES.length).toBe(9);
  });
});

// Plan 07-36 (UAT-3 N7): underline REMOVED — assert no entry with id 'underline'.
describe("Plan 07-36 — Cmd+U underline removed (UAT-3 N7)", () => {
  it("SR-no-underline — shortcutsRegistry does NOT include 'underline' entry", () => {
    const entry = SHORTCUTS_REGISTRY.find((s) => s.id === "underline");
    expect(entry).toBeUndefined();
  });
});

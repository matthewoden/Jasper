import { describe, it, expect } from "vitest";
import {
  SHORTCUTS_REGISTRY,
  COMMAND_PALETTE_ENTRIES,
  CHEAT_SHEET_ENTRIES,
  GROUP_ORDER,
} from "./shortcutsRegistry";

describe("shortcutsRegistry", () => {
  it("registry has all 17 locked Cmd+P palette entries (added Share/Reveal added Switch vault added Toggle Zen Mode added split/focus-pane commands added Toggle left sidebar added Bookmark current note relabeled Switch/search notes to Quick switcher)", () => {
    const labels = COMMAND_PALETTE_ENTRIES.map((s) => s.label);
    expect(labels).toContain("New note");
    expect(labels).toContain("Save");
    expect(labels).not.toContain("Find in note");
    expect(labels).toContain("Today");
    expect(labels).toContain("Quick switcher (notes)");
    expect(labels).toContain("Toggle theme");
    expect(labels).toContain("Refresh index");
    expect(labels).toContain("Reset and rebuild…");
    expect(labels).toContain("Show keyboard shortcuts");
    expect(labels).toContain("Show current note in file manager");
    expect(labels).toContain("Switch vault…");
    expect(labels).toContain("Toggle Zen Mode");
    expect(labels).toContain("Split right");
    expect(labels).toContain("Split down");
    expect(labels).toContain("Focus next pane");
    expect(labels).toContain("Focus previous pane");
    expect(labels).toContain("Toggle left sidebar");
    expect(labels).toContain("Bookmark current note");
    expect(COMMAND_PALETTE_ENTRIES.length).toBe(17);
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
      "Pane",
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


describe("Cmd+F removal", () => {
  it("SR-no-find — shortcutsRegistry does NOT include 'find'", () => {
    const found = SHORTCUTS_REGISTRY.find((s) => s.id === "find");
    expect(found).toBeUndefined();
  });

  it("SR-palette-count — COMMAND_PALETTE_ENTRIES has 17 entries (added Share/Reveal added Switch vault added Toggle Zen Mode added split/focus-pane commands added Toggle left sidebar added Bookmark current note; Find still removed)", () => {
    expect(COMMAND_PALETTE_ENTRIES.length).toBe(17);
  });
});


describe("Cmd+U underline removed", () => {
  it("SR-no-underline — shortcutsRegistry does NOT include 'underline' entry", () => {
    const entry = SHORTCUTS_REGISTRY.find((s) => s.id === "underline");
    expect(entry).toBeUndefined();
  });
});


describe("DEBT-05: vault.switch has no keybinding (palette-only lock)", () => {
  it("vault.switch entry exists in the registry", () => {
    const entry = SHORTCUTS_REGISTRY.find((s) => s.id === "vault.switch");
    expect(entry).toBeDefined();
  });

  it("vault.switch has no shortcut property (undefined)", () => {
    const entry = SHORTCUTS_REGISTRY.find((s) => s.id === "vault.switch");
    expect(entry).toBeDefined();
    expect(entry?.shortcut).toBeUndefined();
  });

  it("vault.switch is reachable via the palette (inPalette === true)", () => {
    const entry = SHORTCUTS_REGISTRY.find((s) => s.id === "vault.switch");
    expect(entry?.inPalette).toBe(true);
  });

  it("vault.switch does NOT appear in the cheat-sheet (inCheatSheet === false)", () => {
    const entry = SHORTCUTS_REGISTRY.find((s) => s.id === "vault.switch");
    expect(entry?.inCheatSheet).toBe(false);
  });

  it("no registry entry declares a Shift+V vault shortcut combination (guards against re-introduction)", () => {
    // Check all shortcut strings for a shift+v pattern in any encoding:
    // - "⌘⇧V" or "⌘⇧v" (Mac symbol form)
    // - "Ctrl Shift V" or "Ctrl Shift v" (non-Mac form)
    // Any entry whose shortcut contains the shift modifier and the letter V is a collision candidate.
    const vaultShiftVEntries = SHORTCUTS_REGISTRY.filter((s) => {
      if (!s.shortcut) return false;
      const sc = s.shortcut.toLowerCase();
      return (sc.includes("⇧v") || sc.includes("shift v"));
    });
    expect(vaultShiftVEntries).toHaveLength(0);
  });
});

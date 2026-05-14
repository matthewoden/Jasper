/**
 * useCommandPalette tests — TDD RED phase.
 * Tests filtering of COMMAND_PALETTE_ENTRIES and execute dispatch.
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCommandPalette } from "./useCommandPalette";
import { COMMAND_PALETTE_ENTRIES } from "./shortcutsRegistry";

describe("useCommandPalette — filtered()", () => {
  it("returns all COMMAND_PALETTE_ENTRIES when query is empty", () => {
    const { result } = renderHook(() => useCommandPalette({}));
    const all = result.current.filtered("");
    expect(all).toHaveLength(COMMAND_PALETTE_ENTRIES.length);
    // Should return all 9 entries
    expect(all).toEqual(COMMAND_PALETTE_ENTRIES);
  });

  it("returns all entries when query is whitespace only", () => {
    const { result } = renderHook(() => useCommandPalette({}));
    const all = result.current.filtered("   ");
    expect(all).toHaveLength(COMMAND_PALETTE_ENTRIES.length);
  });

  it("filters by label substring (case-insensitive)", () => {
    const { result } = renderHook(() => useCommandPalette({}));
    const hits = result.current.filtered("today");
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("today");
  });

  it("filters with uppercase query (case-insensitive)", () => {
    const { result } = renderHook(() => useCommandPalette({}));
    const hits = result.current.filtered("TODAY");
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("today");
  });

  it("returns empty array when query matches nothing", () => {
    const { result } = renderHook(() => useCommandPalette({}));
    const hits = result.current.filtered("zzzzz_no_match_zzzzz");
    expect(hits).toHaveLength(0);
  });

  it("matches partial label substring", () => {
    const { result } = renderHook(() => useCommandPalette({}));
    // "New note" should match "new"
    const hits = result.current.filtered("new");
    expect(hits.some((h) => h.id === "new-note")).toBe(true);
  });

  it("filters multiple matching entries", () => {
    const { result } = renderHook(() => useCommandPalette({}));
    // "index" matches "Refresh index" and "Reset and rebuild…"? — actually only "Refresh index"
    // "re" matches "Refresh index", "Reset and rebuild…"
    const hits = result.current.filtered("re");
    // Should match at least "refresh-index" and "rebuild-index"
    expect(hits.some((h) => h.id === "refresh-index")).toBe(true);
    expect(hits.some((h) => h.id === "rebuild-index")).toBe(true);
  });

  it("preserves the group property on returned entries", () => {
    const { result } = renderHook(() => useCommandPalette({}));
    const hits = result.current.filtered("today");
    expect(hits[0].group).toBe("Navigation");
  });
});

describe("useCommandPalette — execute()", () => {
  it("calls onNewNote when execute('new-note') is called", () => {
    const onNewNote = vi.fn();
    const { result } = renderHook(() => useCommandPalette({ onNewNote }));
    act(() => { result.current.execute("new-note"); });
    expect(onNewNote).toHaveBeenCalledOnce();
  });

  it("calls onSave when execute('save') is called", () => {
    const onSave = vi.fn();
    const { result } = renderHook(() => useCommandPalette({ onSave }));
    act(() => { result.current.execute("save"); });
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("calls onFind when execute('find') is called", () => {
    const onFind = vi.fn();
    const { result } = renderHook(() => useCommandPalette({ onFind }));
    act(() => { result.current.execute("find"); });
    expect(onFind).toHaveBeenCalledOnce();
  });

  it("calls onToday when execute('today') is called", () => {
    const onToday = vi.fn();
    const { result } = renderHook(() => useCommandPalette({ onToday }));
    act(() => { result.current.execute("today"); });
    expect(onToday).toHaveBeenCalledOnce();
  });

  it("calls onSwitchNote when execute('switch-note') is called", () => {
    const onSwitchNote = vi.fn();
    const { result } = renderHook(() => useCommandPalette({ onSwitchNote }));
    act(() => { result.current.execute("switch-note"); });
    expect(onSwitchNote).toHaveBeenCalledOnce();
  });

  it("calls onToggleTheme when execute('toggle-theme') is called", () => {
    const onToggleTheme = vi.fn();
    const { result } = renderHook(() => useCommandPalette({ onToggleTheme }));
    act(() => { result.current.execute("toggle-theme"); });
    expect(onToggleTheme).toHaveBeenCalledOnce();
  });

  it("calls onRefreshIndex when execute('refresh-index') is called", () => {
    const onRefreshIndex = vi.fn();
    const { result } = renderHook(() => useCommandPalette({ onRefreshIndex }));
    act(() => { result.current.execute("refresh-index"); });
    expect(onRefreshIndex).toHaveBeenCalledOnce();
  });

  it("calls onRebuildIndex when execute('rebuild-index') is called", () => {
    const onRebuildIndex = vi.fn();
    const { result } = renderHook(() => useCommandPalette({ onRebuildIndex }));
    act(() => { result.current.execute("rebuild-index"); });
    expect(onRebuildIndex).toHaveBeenCalledOnce();
  });

  it("calls onShowShortcuts when execute('show-shortcuts') is called", () => {
    const onShowShortcuts = vi.fn();
    const { result } = renderHook(() => useCommandPalette({ onShowShortcuts }));
    act(() => { result.current.execute("show-shortcuts"); });
    expect(onShowShortcuts).toHaveBeenCalledOnce();
  });

  it("does nothing when execute is called with unknown id", () => {
    const onNewNote = vi.fn();
    const { result } = renderHook(() => useCommandPalette({ onNewNote }));
    // Should not throw
    act(() => { result.current.execute("does-not-exist"); });
    expect(onNewNote).not.toHaveBeenCalled();
  });

  it("does nothing when action is not provided (optional action)", () => {
    const { result } = renderHook(() => useCommandPalette({}));
    // Should not throw even when no actions are provided
    act(() => { result.current.execute("new-note"); });
  });
});

describe("useCommandPalette — all 9 COMMAND_PALETTE_ENTRIES reachable", () => {
  it("all 9 palette entries are reachable via filtered('')", () => {
    const { result } = renderHook(() => useCommandPalette({}));
    const all = result.current.filtered("");
    const ids = all.map((e) => e.id);
    // The 9 palette-eligible commands from shortcutsRegistry
    const expectedIds = [
      "new-note",
      "save",
      "find",
      "today",
      "switch-note",
      "toggle-theme",
      "refresh-index",
      "rebuild-index",
      "show-shortcuts",
    ];
    for (const id of expectedIds) {
      expect(ids).toContain(id);
    }
  });
});

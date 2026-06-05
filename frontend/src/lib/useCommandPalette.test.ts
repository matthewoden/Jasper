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
    const hits = result.current.filtered("new");
    expect(hits.some((h) => h.id === "new-note")).toBe(true);
  });

  it("filters multiple matching entries", () => {
    const { result } = renderHook(() => useCommandPalette({}));
    const hits = result.current.filtered("re");
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
    act(() => { result.current.execute("does-not-exist"); });
    expect(onNewNote).not.toHaveBeenCalled();
  });

  it("does nothing when action is not provided (optional action)", () => {
    const { result } = renderHook(() => useCommandPalette({}));
    act(() => { result.current.execute("new-note"); });
  });
});

describe("useCommandPalette — execute() closeOnExecute verdict (UAT #5)", () => {
  it("switch-note returns false (keep palette open)", () => {
    const onSwitchNote = vi.fn();
    const { result } = renderHook(() => useCommandPalette({ onSwitchNote }));
    let verdict: boolean = true;
    act(() => { verdict = result.current.execute("switch-note"); });
    expect(verdict).toBe(false);
    expect(onSwitchNote).toHaveBeenCalledOnce();
  });

  it("new-note returns true (close palette)", () => {
    const onNewNote = vi.fn();
    const { result } = renderHook(() => useCommandPalette({ onNewNote }));
    let verdict: boolean = false;
    act(() => { verdict = result.current.execute("new-note"); });
    expect(verdict).toBe(true);
    expect(onNewNote).toHaveBeenCalledOnce();
  });

  it("save returns true (close palette)", () => {
    const onSave = vi.fn();
    const { result } = renderHook(() => useCommandPalette({ onSave }));
    let verdict: boolean = false;
    act(() => { verdict = result.current.execute("save"); });
    expect(verdict).toBe(true);
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("unknown id returns true and dispatches no action", () => {
    const { result } = renderHook(() => useCommandPalette({}));
    let verdict: boolean = false;
    act(() => { verdict = result.current.execute("does-not-exist"); });
    expect(verdict).toBe(true);
  });
});

describe("useCommandPalette — all 8 COMMAND_PALETTE_ENTRIES reachable (Plan 07-27: find removed)", () => {
  it("all 8 palette entries are reachable via filtered('')", () => {
    const { result } = renderHook(() => useCommandPalette({}));
    const all = result.current.filtered("");
    const ids = all.map((e) => e.id);
    const expectedIds = [
      "new-note",
      "save",
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
    expect(ids).not.toContain("find");
  });
});

/**
 * App.tsx global keyboard-shortcut handlers + the tiny pub/sub event bus
 * that bridges window-level handlers (which run outside the React render
 * cycle) to React-side hooks consumed inside AppInner.
 *
 * Extracted from App.tsx so that file only exports React components —
 * satisfies react-refresh/only-export-components and restores Fast
 * Refresh DX for App.tsx itself. The handlers are pure functions
 * driven by KeyboardEvent + the global useTreeStore, so the extraction
 * is mechanical.
 *
 * Each handler is unit-tested directly in App.test.tsx (KC-*, F2-*,
 * Cmd+P, Cmd+O, Cmd+Shift+D, Cmd+/, Cmd+Shift+F, KC-B, KC-I).
 */
import { useTreeStore } from "./useTreeStore";


export type Phase7DispatchEvent = "openToday";

const phase7Subscribers = new Set<(ev: Phase7DispatchEvent) => void>();

export function dispatchPhase7(ev: Phase7DispatchEvent): void {
  for (const fn of Array.from(phase7Subscribers)) fn(ev);
}

export function subscribePhase7(
  fn: (ev: Phase7DispatchEvent) => void,
): () => void {
  phase7Subscribers.add(fn);
  return () => {
    phase7Subscribers.delete(fn);
  };
}

/**
 * Plan 03-20 Gap R2-4 — document-level F2 routing.
 *
 * Clicking a tree row mounts the editor and EditorPane.useEffect focuses
 * the textarea on `loadStatus === "loaded"`. Without this handler, F2
 * dispatched by the user would arrive at the textarea (or whichever
 * element holds focus) and Plan 03-12's row-local F2 handler would
 * never see it. Routing F2 through the document level + reading the
 * most-recently-clicked row from useTreeStore.selectedRow ensures
 * rename works regardless of which element holds focus.
 *
 * Guard order (intentional):
 *   1. e.key !== "F2"             → fast bail-out for the common case
 *   2. target is form-control     → don't hijack typing in inputs /
 *                                   textareas / contenteditable
 *   3. pendingRename != null      → defer to RenameInput's own handlers
 *   4. selectedRow == null        → nothing to rename; no-op
 */
export function handleAppF2KeyDown(e: KeyboardEvent): void {
  if (e.key !== "F2") return;
  const target = e.target;
  if (
    target instanceof HTMLElement &&
    target.matches("input, textarea, [contenteditable=true]")
  ) {
    return;
  }
  const state = useTreeStore.getState();
  if (state.pendingRename !== null) return;
  const sr = state.selectedRow;
  if (sr === null) return;
  e.preventDefault();
  state.startRename(sr.kind, sr.target);
}

/**
 * UAT follow-up 2026-05-12 — global panel-toggle shortcuts.
 *
 * Cmd+Alt+T (Mac) / Ctrl+Alt+T (Win/Linux) — toggle Tags panel.
 * Cmd+Alt+B (Mac) / Ctrl+Alt+B (Win/Linux) — toggle Backlinks panel.
 *
 * Modifier choice — Cmd+Alt prefix avoids the heavily-used Cmd-only
 * namespace so this never collides with built-in browser shortcuts.
 * Letters: T(ags), B(acklinks).
 */
export function handleAppPanelShortcuts(e: KeyboardEvent): void {
  if (!e.altKey || !(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k !== "t" && k !== "b") return;
  e.preventDefault();
  e.stopPropagation();
  const s = useTreeStore.getState();
  if (k === "t") {
    const next = !s.panelSelector.tags;
    s.setPanelSelector({ tags: next });
    if (next && !s.backlinksRailExpanded) s.setBacklinksRailExpanded(true);
  } else {
    const next = !s.panelSelector.backlinks;
    s.setPanelSelector({ backlinks: next });
    if (next && !s.backlinksRailExpanded) s.setBacklinksRailExpanded(true);
  }
}

/**
 * Cmd+P — open command palette (mode="commands").
 * preventDefault prevents the browser's native Print dialog.
 */
export function handleAppCmdP(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key !== "p" && e.key !== "P") return;
  e.preventDefault();
  e.stopPropagation();
  const s = useTreeStore.getState();
  s.setPaletteMode("commands");
  s.setPaletteOpen(true);
}

/**
 * Cmd+O — open quick-switcher (mode="notes").
 * preventDefault prevents the browser's native Open File dialog.
 */
export function handleAppCmdO(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key !== "o" && e.key !== "O") return;
  e.preventDefault();
  e.stopPropagation();
  const s = useTreeStore.getState();
  s.setPaletteMode("notes");
  s.setPaletteOpen(true);
}

/**
 * Cmd+Shift+D — open today's daily note.
 * Dispatches via phase7 event bus (can't call useDailyNote hook directly
 * from a window event listener — no React context available).
 */
export function handleAppCmdShiftD(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (!e.shiftKey) return;
  if (e.key !== "d" && e.key !== "D") return;
  e.preventDefault();
  e.stopPropagation();
  dispatchPhase7("openToday");
}

/**
 * Cmd+/ — open keyboard shortcuts cheat-sheet dialog.
 */
export function handleAppCmdSlash(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key !== "/") return;
  e.preventDefault();
  e.stopPropagation();
  useTreeStore.getState().setCheatSheetOpen(true);
}

/**
 * Plan 07-40 (UAT-6) — Cmd+Shift+F opens CommandMenu mode='search'.
 *
 * REVERSES Plan 07-39's focus-bus dispatch. Search now lives in its own
 * palette mode (third surface alongside Cmd+O switcher and Cmd+P
 * palette) rather than as a Sidebar input.
 */
export function handleAppCmdShiftF(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (!e.shiftKey) return;
  if (e.key !== "f" && e.key !== "F") return;
  e.preventDefault();
  e.stopPropagation();
  const s = useTreeStore.getState();
  s.setPaletteMode("search");
  s.setPaletteOpen(true);
}

/**
 * Cmd+B — bold (CM6 owns this via jasperKeymap.ts toggleBold).
 *
 * UAT #8 fix: Brave/Chromium browsers with extensions intercept Cmd+B
 * before CM6. We register a WINDOW-level capture-phase handler that
 * blocks the browser/OS default for the font panel / Brave Leo sidebar.
 *
 * Plan 07-24 bug fix (Rule 1): only preventDefault when the event does
 * NOT originate inside the CM6 editor — unconditional preventDefault
 * sets event.defaultPrevented and CM6's eventBelongsToEditor returns
 * false, skipping toggleBold.
 */
export function handleAppCmdB(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key !== "b" && e.key !== "B") return;
  const isInsideEditor =
    (e.target as HTMLElement | null)?.closest?.(".cm-editor") != null;
  if (!isInsideEditor) {
    e.preventDefault();
  }
  // No stopPropagation — CM6's event handlers must still fire.
}

/**
 * Cmd+I — italic (CM6 owns via jasperKeymap.ts toggleItalic).
 * Same fix shape as handleAppCmdB.
 */
export function handleAppCmdI(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key !== "i" && e.key !== "I") return;
  const isInsideEditor =
    (e.target as HTMLElement | null)?.closest?.(".cm-editor") != null;
  if (!isInsideEditor) {
    e.preventDefault();
  }
}

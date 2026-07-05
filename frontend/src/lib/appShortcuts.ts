/**
 * Global keyboard-shortcut handlers and the tiny pub/sub event bus that
 * bridges window-level handlers (outside the React render cycle) to hooks
 * inside AppInner. Extracted from App.tsx so that file exports only React
 * components, satisfying react-refresh/only-export-components.
 */
import { useTreeStore } from "./useTreeStore";


export type Phase7DispatchEvent = "openToday" | "newTab" | "focusSearch";

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
 * Document-level F2 routing. Routes F2 through the document rather than
 * relying on the focused element, so rename works regardless of which element
 * holds focus when F2 is pressed.
 *
 * Guard order (intentional):
 *   1. e.key !== "F2"          → fast bail-out
 *   2. target is form-control  → don't hijack typing in inputs / textareas / contenteditable
 *   3. pendingRename != null   → defer to RenameInput's own handlers
 *   4. selectedRow == null     → nothing to rename; no-op
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
 * Global panel-toggle shortcuts.
 * Cmd+Alt+T — toggle the right-rail Tags section; Cmd+Alt+B — toggle the
 * right-rail Linked-mentions section. Cmd+Alt prefix avoids collisions with
 * the heavily-used Cmd-only namespace. Repointed (Phase 20, D-01) from the
 * retired panel-selector slice onto the per-section collapse booleans; still
 * reveals the rail when expanding a section.
 */
export function handleAppPanelShortcuts(e: KeyboardEvent): void {
  if (!e.altKey || !(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k !== "t" && k !== "b") return;
  e.preventDefault();
  e.stopPropagation();
  const s = useTreeStore.getState();
  if (k === "t") {
    const next = !s.tagsPanelExpanded;
    s.setTagsPanelExpanded(next);
    if (next && !s.backlinksRailExpanded) s.setBacklinksRailExpanded(true);
  } else {
    const next = !s.linkedMentionsPanelExpanded;
    s.setLinkedMentionsPanelExpanded(next);
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
 * Dispatches via event bus because useDailyNote can't be called from a
 * window event listener (no React context available there).
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
 * Alt+T — open a new untitled note as a tab (bootstrap path; tab-new).
 *
 * Matches the PHYSICAL KeyT code, not the produced key value: on macOS Option+T
 * emits key:"†" (a dead-key char) while still reporting code:"KeyT". Guarding on
 * e.code lets Option+T fire newTab AND preventDefault, so the "†" never types
 * into CodeMirror. The !metaKey && !ctrlKey guard keeps plain Alt+T disjoint from
 * the Cmd+Alt+T Tags-panel toggle in handleAppPanelShortcuts. No tab-count check:
 * Alt+T must work from a zero-tab state, since it is the only keyboard way to
 * create the first tab.
 */
export function handleAppAltT(e: KeyboardEvent): void {
  if (!(e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyT")) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  dispatchPhase7("newTab");
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
 * Cmd+Shift+F — opens the sidebar Search panel + focuses its input (D-05).
 * Re-pointed from the Phase 7 palette-search stopgap: the in-sidebar Search
 * panel (Plan 06) is now the target, not CommandMenu. While the panel is
 * already open, this refocuses the input and selects the existing query
 * (SidebarSearchPanel's own focusSearch subscriber owns that behavior).
 */
export function handleAppCmdShiftF(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (!e.shiftKey) return;
  if (e.key !== "f" && e.key !== "F") return;
  e.preventDefault();
  e.stopPropagation();
  const s = useTreeStore.getState();
  s.setSidebarPanel("search");
  s.setNotesSidebarVisible(true);
  // See ActivityRibbon.tsx's Search button handler: when this switches from
  // Files (or opens a closed sidebar), SidebarSearchPanel mounts in this same
  // tick and its subscribePhase7 effect only registers after React commits —
  // a synchronous dispatch here would fire before any subscriber exists.
  requestAnimationFrame(() => dispatchPhase7("focusSearch"));
}

/**
 * Cmd+B — bold (CM6 owns this via jasperKeymap.ts toggleBold).
 *
 * Brave/Chromium extensions intercept Cmd+B before CM6 at the window level.
 * Only preventDefault when the event does NOT originate inside the CM6 editor —
 * unconditional preventDefault sets event.defaultPrevented and CM6's
 * eventBelongsToEditor returns false, causing toggleBold to be skipped.
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
 * Same Brave/Chromium interception fix as handleAppCmdB.
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

/**
 * Global keyboard-shortcut handlers and the tiny pub/sub event bus that
 * bridges window-level handlers (outside the React render cycle) to hooks
 * inside AppInner. Extracted from App.tsx so that file exports only React
 * components, satisfying react-refresh/only-export-components.
 */
import { useTreeStore, type RightPanelTab } from "./useTreeStore";
import { usePaneStore } from "./usePaneStore";
import { putWorkspace } from "./workspaceApi";


export type Phase7DispatchEvent =
  | "openToday"
  | "newTab"
  | "focusSearch"
  | "bookmarkCurrent";

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
 * Best-effort optimistic switch + persist for the right-rail's active tab,
 * used by handleAppPanelShortcuts below — mirrors useWorkspace.ts's
 * setRightPanel shape (optimistic slice update, PUT /vault/workspace,
 * revert on failure), but without a toast since this fires from a
 * window-level handler with no React context.
 */
function selectRightPanel(panel: RightPanelTab): void {
  const previous = useTreeStore.getState().rightPanel;
  useTreeStore.getState().setRightPanel(panel);
  if (previous === panel) return;
  void putWorkspace({ rightPanel: panel }).catch(() => {
    useTreeStore.getState().setRightPanel(previous);
  });
}

/**
 * Global panel-select shortcuts.
 * Cmd+Alt+T — select the right-rail Tags tab; Cmd+Alt+B — select the
 * right-rail Linked-mentions tab. Cmd+Alt prefix avoids collisions with
 * the heavily-used Cmd-only namespace. Repointed (Phase 30, TAGS-01) from
 * the retired per-section collapse booleans onto the tab-row's persisted
 * rightPanel field: pressing the shortcut for the ALREADY-active tab while
 * the rail is visible collapses the rail (closest available analog to the
 * old "toggle" behavior in a one-panel-at-a-time model); otherwise it
 * switches to that tab and reveals the rail if collapsed.
 *
 * Matches the PHYSICAL KeyT/KeyB codes, not the produced key value: on macOS
 * Option+T emits key:"†" and Option+B emits key:"∫" (holding Cmd does not
 * suppress the transformation), while code stays "KeyT"/"KeyB" — the same
 * hazard handleAppAltT guards against below.
 */
export function handleAppPanelShortcuts(e: KeyboardEvent): void {
  if (!e.altKey || !(e.metaKey || e.ctrlKey)) return;
  if (e.code !== "KeyT" && e.code !== "KeyB") return;
  e.preventDefault();
  e.stopPropagation();
  const s = useTreeStore.getState();
  const target: RightPanelTab = e.code === "KeyT" ? "tags" : "backlinks";
  if (s.rightPanel === target && s.backlinksRailExpanded) {
    s.setBacklinksRailExpanded(false);
    return;
  }
  selectRightPanel(target);
  if (!useTreeStore.getState().backlinksRailExpanded) {
    useTreeStore.getState().setBacklinksRailExpanded(true);
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
 * Cmd+. — toggle zen mode (Phase 22, ZEN-01).
 * Verified CM6's keymap stack does not bind Mod-. (see 22-PATTERNS.md);
 * safe to claim at the window capture-phase tier with no editor-side guard.
 */
export function handleAppCmdDot(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key !== ".") return;
  e.preventDefault();
  e.stopPropagation();
  useTreeStore.getState().toggleZen();
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
 * Cmd+Shift+E — toggle the left sidebar (Phase 27 NAV-03, D-13).
 * The header collapse control (Plan 03) and PaneCornerReopenButton (Plan 04
 * Task 1) both read/write the same notesSidebarVisible flag; this is the
 * keyboard path so removing the ribbon Files/Search toggles doesn't leave
 * keyboard users without a way to collapse/reopen the sidebar.
 */
export function handleAppSidebarToggle(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (!e.shiftKey) return;
  if (e.key !== "e" && e.key !== "E") return;
  e.preventDefault();
  e.stopPropagation();
  const s = useTreeStore.getState();
  s.setNotesSidebarVisible(!s.notesSidebarVisible);
}

/**
 * Cmd+Shift+B — bookmark/un-bookmark the active pane's active note
 * (Phase 27 BOOK-01, D-14). toggleBookmark lives inside the useBookmarks
 * hook (React state + a WS subscriber), unreachable from this window-level
 * handler — dispatched via the same phase7 event bus handleAppCmdShiftD
 * uses for openToday, so App.tsx's subscriber (which HAS toggleBookmark in
 * scope) performs the actual mutation.
 */
export function handleAppBookmarkToggle(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (!e.shiftKey) return;
  if (e.key !== "b" && e.key !== "B") return;
  e.preventDefault();
  e.stopPropagation();
  dispatchPhase7("bookmarkCurrent");
}

/**
 * Cmd+B — bold (CM6 owns this via jasperKeymap.ts toggleBold).
 *
 * Brave/Chromium extensions intercept Cmd+B before CM6 at the window level.
 * Only preventDefault when the event does NOT originate inside the CM6 editor —
 * unconditional preventDefault sets event.defaultPrevented and CM6's
 * eventBelongsToEditor returns false, causing toggleBold to be skipped.
 *
 * e.shiftKey is explicitly excluded (WR-05) so this handler never matches
 * Cmd+Shift+B, which handleAppBookmarkToggle owns independently on the same
 * window listener list; without the guard both handlers would run on the
 * same keystroke.
 */
export function handleAppCmdB(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.shiftKey) return;
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
 * Same Brave/Chromium interception fix as handleAppCmdB. Same e.shiftKey
 * exclusion rationale as handleAppCmdB (WR-05) — no Shift-I shortcut exists
 * today, but the guard keeps the two Cmd/Shift-prefixed handler families
 * disjoint on principle.
 */
export function handleAppCmdI(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.shiftKey) return;
  if (e.key !== "i" && e.key !== "I") return;
  const isInsideEditor =
    (e.target as HTMLElement | null)?.closest?.(".cm-editor") != null;
  if (!isInsideEditor) {
    e.preventDefault();
  }
}

/**
 * True when the event target is a form control that should keep receiving
 * raw keystrokes (input / textarea / contenteditable) — shared guard for the
 * Phase 25 split/focus-pane shortcuts below, mirroring handleAppF2KeyDown's
 * do-not-hijack-typing check.
 */
function isTypingTarget(e: KeyboardEvent): boolean {
  const target = e.target;
  return (
    target instanceof HTMLElement &&
    target.matches("input, textarea, [contenteditable=true]")
  );
}

/**
 * Cmd+\ — Split right (D-14/D-15): new leaf to the right of the active pane,
 * cloning its current note. Chosen to mirror VSCode's "split editor right"
 * muscle memory; grep-audited against SHORTCUTS_REGISTRY for collisions.
 */
export function handleAppSplitRight(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
  if (e.key !== "\\") return;
  if (isTypingTarget(e)) return;
  e.preventDefault();
  e.stopPropagation();
  usePaneStore.getState().splitActivePane("row");
}

/**
 * Cmd+Shift+\ — Split down (D-14/D-15): new leaf below the active pane,
 * cloning its current note.
 */
export function handleAppSplitDown(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
  if (e.key !== "\\" && e.key !== "|") return;
  if (isTypingTarget(e)) return;
  e.preventDefault();
  e.stopPropagation();
  usePaneStore.getState().splitActivePane("col");
}

/**
 * Cmd+Alt+Right — Focus next pane (D-08), cycling activePaneId forward
 * through the leaf order. No-ops (via usePaneStore.focusCyclePane) with a
 * single leaf.
 */
export function handleAppFocusNextPane(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey) || !e.altKey) return;
  if (e.key !== "ArrowRight") return;
  if (isTypingTarget(e)) return;
  e.preventDefault();
  e.stopPropagation();
  usePaneStore.getState().focusCyclePane(1);
}

/**
 * Cmd+Alt+Left — Focus previous pane (D-08), cycling activePaneId backward
 * through the leaf order.
 */
export function handleAppFocusPrevPane(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey) || !e.altKey) return;
  if (e.key !== "ArrowLeft") return;
  if (isTypingTarget(e)) return;
  e.preventDefault();
  e.stopPropagation();
  usePaneStore.getState().focusCyclePane(-1);
}

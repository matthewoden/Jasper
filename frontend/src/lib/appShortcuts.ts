/**
 * Global keyboard-shortcut handlers and the tiny pub/sub event bus that
 * bridges window-level handlers (outside the React render cycle) to hooks
 * inside AppInner. Extracted from App.tsx so that file exports only React
 * components, satisfying react-refresh/only-export-components.
 */
import { useTreeStore, type RightPanelTab } from "./useTreeStore";
import { usePaneStore } from "./usePaneStore";
import { putWorkspace } from "./workspaceApi";


export type AppShortcutEvent =
  | "openToday"
  | "newTab"
  | "focusSearch"
  | "bookmarkCurrent";

const appShortcutSubscribers = new Set<(ev: AppShortcutEvent) => void>();

export function dispatchAppShortcut(ev: AppShortcutEvent): void {
  for (const fn of Array.from(appShortcutSubscribers)) fn(ev);
}

export function subscribeAppShortcut(
  fn: (ev: AppShortcutEvent) => void,
): () => void {
  appShortcutSubscribers.add(fn);
  return () => {
    appShortcutSubscribers.delete(fn);
  };
}

/**
 * F2 routes through the document, not the focused element, so rename works
 * wherever focus happens to be. Guard order matters: bail on the key, then
 * form controls, then an in-progress rename, then no selection.
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
 * Cmd+Alt+T / Cmd+Alt+B select the right-rail Tags / Linked-mentions tabs.
 * Pressing the already-active tab's shortcut collapses the rail.
 *
 * Matches the PHYSICAL KeyT/KeyB codes: on macOS Option+T emits "†" and
 * Option+B emits "∫" even with Cmd held, while `code` stays stable.
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
 * Cmd+. — toggle zen mode (ZEN-01).
 * CM6's keymap stack does not bind Mod-, so this is
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
  dispatchAppShortcut("openToday");
}

/**
 * Alt+T opens a new untitled note. Matches the physical KeyT code so the macOS
 * "†" dead-key char never types into CodeMirror, and excludes Cmd/Ctrl to stay
 * disjoint from Cmd+Alt+T.
 *
 * Deliberately no tab-count check: this is the only keyboard route to the FIRST
 * tab, so it must work from a zero-tab state.
 */
export function handleAppAltT(e: KeyboardEvent): void {
  if (!(e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyT")) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  dispatchAppShortcut("newTab");
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
 * Cmd+Shift+F — opens the sidebar Search panel + focuses its input.
 * Re-pointed from an earlier palette-search stopgap: the in-sidebar Search
 * panel is now the target, not CommandMenu. While the panel is
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
  // tick and its subscribeAppShortcut effect only registers after React commits —
  // a synchronous dispatch here would fire before any subscriber exists.
  requestAnimationFrame(() => dispatchAppShortcut("focusSearch"));
}

/**
 * Cmd+Shift+E — toggle the left sidebar (NAV-03).
 * The header collapse control and PaneCornerReopenButton both read/write
 * the same notesSidebarVisible flag; this is the
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
 * (BOOK-01). toggleBookmark lives inside the useBookmarks
 * hook (React state + a WS subscriber), unreachable from this window-level
 * handler — dispatched via the same event bus handleAppCmdShiftD
 * uses for openToday, so App.tsx's subscriber (which HAS toggleBookmark in
 * scope) performs the actual mutation.
 */
export function handleAppBookmarkToggle(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (!e.shiftKey) return;
  if (e.key !== "b" && e.key !== "B") return;
  e.preventDefault();
  e.stopPropagation();
  dispatchAppShortcut("bookmarkCurrent");
}

/**
 * Cmd+B exists only because Brave/Chromium extensions intercept it before CM6.
 * preventDefault ONLY outside the editor — doing it unconditionally sets
 * defaultPrevented, and CM6's eventBelongsToEditor then skips toggleBold.
 *
 * shiftKey is excluded so this never double-fires with Cmd+Shift+B.
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
 * exclusion rationale as handleAppCmdB — no Shift-I shortcut exists
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
 * split/focus-pane shortcuts below, mirroring handleAppF2KeyDown's
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
 * Cmd+\ — Split right: new leaf to the right of the active pane,
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
 * Cmd+Shift+\ — Split down: new leaf below the active pane,
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
 * Cmd+Alt+Right — Focus next pane, cycling activePaneId forward
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
 * Cmd+Alt+Left — Focus previous pane, cycling activePaneId backward
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

/**
 * Phase 2 app shell. Phase 1's locked three-column grid is preserved unchanged
 * (260px / 1fr / 0); Phase 2 wraps it with:
 *   - <ToastProvider> at the root (mounted ONCE per UI-SPEC §Forward-Compat
 *     assert #3; Phase 4 + Phase 5 reuse this provider)
 *   - <MigrationBanner /> as a flex-column row above the grid (Surface 1).
 *     Renders nothing when state=ok, so visual drift from Phase 1 is zero.
 *   - <ResetAndRebuildDialog /> portal (Surface 2; Radix manages portal mount)
 *   - <ReindexProgress /> overlay replaces the EditorPane while reindexPhase
 *     is non-idle (Surface 3). When idle, the EditorPane renders normally.
 *
 * The reindex state machine lives HERE in AppInner (W-4 lock). ReindexProgress
 * is presentational; this file owns the phase enum and drives the transitions
 * idle → running → completing → idle (success path) or idle → running →
 * error → idle (error path, after Close).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { RightRail } from "./components/RightRail";
import { CommandMenu } from "./components/CommandMenu";
import { EditorPane, type EditorPaneHandlers } from "./components/EditorPane";
import { KeyboardShortcutsDialog } from "./components/KeyboardShortcutsDialog";
import { MigrationBanner } from "./components/MigrationBanner";
import { RenameRewriteErrorBanner, type RewriteError } from "./components/RenameRewriteErrorBanner";
import { ReindexProgress } from "./components/ReindexProgress";
import { ResetAndRebuildDialog } from "./components/ResetAndRebuildDialog";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TopBar } from "./components/TopBar";
import { ToastProvider } from "./components/Toast";
import { postAdminReindex } from "./lib/adminApi";
import { useDailyNote } from "./lib/useDailyNote";
import { useMigrationStatus } from "./lib/useMigrationStatus";
import { useReveal } from "./lib/useReveal";
import { useSessionSync, type SessionSyncHandlers } from "./lib/useSessionSync";
import { useTreeStore } from "./lib/useTreeStore";
import { useTreeCreateActions } from "./lib/useTreeCreateActions";
import { useFileTree } from "./lib/useFileTree";
import type { CommandActions } from "./lib/useCommandPalette";
import type { TreeNode } from "./lib/treeApi";

// Plan 08-06 (D-26 / SHARE-01 Mount C): resolve activeNoteId → path by
// walking the in-memory wire tree. Mirrors the helper in Breadcrumbs.tsx;
// we duplicate it here rather than export from Breadcrumbs to avoid an
// inter-component import cycle (Breadcrumbs lives inside TopBar).
function findActiveNotePath(
  nodes: ReadonlyArray<TreeNode>,
  id: string,
): string | null {
  for (const node of nodes) {
    if (node.kind === "note" && node.id === id) return node.path;
    if (node.kind === "folder" && Array.isArray(node.children)) {
      const found = findActiveNotePath(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 7 (Plan 07-12) — Global keymap module-level event bus.
//
// Window event listeners run outside the React render cycle, so they can't
// call hooks directly. This tiny pub/sub bridges the gap: handlers dispatch
// events; AppInner subscribes in a useEffect to call the actual hook methods.
// Pattern mirrors dispatchTagEvent from useTagBrowser.ts.
// ────────────────────────────────────────────────────────────────────────────
type Phase7DispatchEvent = "openToday";
const phase7Subscribers = new Set<(ev: Phase7DispatchEvent) => void>();

function dispatchPhase7(ev: Phase7DispatchEvent) {
  for (const fn of Array.from(phase7Subscribers)) fn(ev);
}

function subscribePhase7(fn: (ev: Phase7DispatchEvent) => void): () => void {
  phase7Subscribers.add(fn);
  return () => {
    phase7Subscribers.delete(fn);
  };
}

// W-4 LOCKED: the parent owns the phase enum; ReindexProgress is purely
// presentational. 'starting' is driven by WS reindex:started events (Plan
// 04-05 / UX-04); Phase 2 transitions directly idle → running on confirm
// for the manual reindex path.
type ReindexPhase =
  | "idle"
  | "starting"
  | "running"
  | "completing"
  | "error";

const SUCCESS_TRANSIENT_MS = 600;

/**
 * Plan 03-20 Gap R2-4 — document-level F2 routing.
 *
 * Clicking a tree row mounts the editor and EditorPane.useEffect
 * focuses the textarea on `loadStatus === "loaded"`. Without this
 * handler, F2 dispatched by the user would arrive at the textarea
 * (or whichever element holds focus) and Plan 03-12's row-local F2
 * handler would never see it. Routing F2 through the document level
 * + reading the most-recently-clicked row from
 * useTreeStore.selectedRow ensures rename works regardless of which
 * element holds focus.
 *
 * Guard order (intentional):
 *   1. e.key !== "F2"             → fast bail-out for the common case
 *   2. target is form-control     → don't hijack typing in inputs /
 *                                   textareas / contenteditable
 *      (RenameInput.tsx itself stops propagation on every keystroke
 *      per Plan 03-12, so this guard is mostly defense-in-depth +
 *      the load-bearing case for Gap R2-4 — the editor textarea)
 *   3. pendingRename != null      → a rename is already in progress;
 *                                   defer to RenameInput's own
 *                                   handlers
 *   4. selectedRow == null        → nothing to rename; no-op
 *
 * Only when all guards pass do we preventDefault + dispatch
 * startRename. The TreeRow's local F2 handler (Plan 03-12) is
 * unchanged — it remains the fallback for the auto-focused-row
 * case (e.g., right after a toolbar create when arborist auto-
 * focuses the new row before the editor takes over).
 *
 * Exported as a named function so unit tests can drive it as a
 * pure function instead of reaching into a mounted React tree's
 * effect — same pattern other one-shot handlers in the codebase
 * follow.
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
  // If a rename is already in progress, defer to its own handlers.
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
 * Modifier choice — Cmd+Alt prefix avoids the heavily-used Cmd-only namespace
 * (Cmd+T new tab, Cmd+W close tab, Cmd+Shift+T restore tab, Cmd+S save,
 * Cmd+F find, Cmd+K command palette) so this never collides with anything
 * the user already has muscle memory for. Letters: T(ags), B(acklinks) —
 * trivially memorable.
 *
 * Behavior: toggles the panelSelector slice. If opening a panel while the
 * rail is collapsed, also expands the rail. If closing the last visible
 * panel, the rail auto-collapses via RightRail's useEffect.
 *
 * Exported for unit tests, mirroring handleAppF2KeyDown.
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
 * Phase 7 (Plan 07-12) — Global capture-phase keymap handlers.
 *
 * Each handler checks meta/ctrl modifier first (fast bail-out for the common
 * case where no modifier is held). capture=true registration (in AppInner's
 * useEffect) intercepts before CM6 processes keyboard events (RESEARCH §Pitfall 5).
 *
 * NOT in this list: Cmd+B, Cmd+I, Cmd+F, Cmd+S — CM6 keymap owns those.
 *
 * Exported as named functions so unit tests can drive them as pure functions
 * (same pattern as handleAppF2KeyDown / handleAppPanelShortcuts).
 */

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
 * palette mode (third surface alongside Cmd+O switcher and Cmd+P palette)
 * rather than as a Sidebar input. This matches handleAppCmdP / handleAppCmdO
 * pattern: set paletteMode + paletteOpen, the modal renders the matching
 * mode='search' content.
 *
 * preventDefault keeps the browser/OS default for Cmd+Shift+F (Fullscreen in
 * some browsers) from firing.
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
 * Cmd+B — bold (CM6 owns this in its editor-level keymap via jasperKeymap.ts).
 *
 * UAT #8 fix: Brave (and other Chromium browsers with extensions like
 * Leo AI) intercept Cmd+B before it reaches CM6. We register a
 * WINDOW-level capture-phase handler that blocks the browser/OS default
 * for the font panel / Leo sidebar.
 *
 * Plan 07-24 bug fix (Rule 1): the original handler called e.preventDefault()
 * unconditionally, which set event.defaultPrevented=true. CM6's internal
 * eventBelongsToEditor() returns false when defaultPrevented is set — so
 * CM6 was skipping the event entirely, preventing toggleBold from running.
 *
 * Fix: only call preventDefault when the event does NOT originate from
 * inside the CM6 editor. When focus is in the editor, CM6's keymap handles
 * Cmd+B via toggleBold (jasperKeymap.ts) — no preventDefault needed at
 * the window level. When focus is outside the editor (sidebar, dialog, etc.),
 * block the OS/browser default to prevent Brave Leo / font panel.
 *
 * Test pinned in App.test.tsx (KC-B-*).
 */
export function handleAppCmdB(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key !== "b" && e.key !== "B") return;
  // Only block the browser default when outside the CM6 editor.
  // Inside the editor, CM6's jasperKeymap handles Cmd+B via toggleBold.
  // Unconditional preventDefault breaks CM6's eventBelongsToEditor check.
  const isInsideEditor =
    (e.target as HTMLElement | null)?.closest?.(".cm-editor") != null;
  if (!isInsideEditor) {
    e.preventDefault();
  }
  // No stopPropagation — CM6's event handlers must still fire.
}

/**
 * Cmd+I — italic (CM6 owns via jasperKeymap.ts toggleItalic).
 *
 * Plan 07-24 bug fix: same fix as handleAppCmdB — only preventDefault
 * when outside the CM6 editor to avoid breaking CM6's eventBelongsToEditor.
 */
export function handleAppCmdI(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key !== "i" && e.key !== "I") return;
  const isInsideEditor =
    (e.target as HTMLElement | null)?.closest?.(".cm-editor") != null;
  if (!isInsideEditor) {
    e.preventDefault();
  }
  // No stopPropagation — CM6's event handlers must still fire.
}

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}

function AppInner() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reindexPhase, setReindexPhase] = useState<ReindexPhase>("idle");
  const [reindexError, setReindexError] = useState<string | undefined>();
  // Plan 06-11 (D-36/D-37): rewrite error banner state. Populated by the
  // onLinksRewritten handler when the server signals a partial rollback, or
  // by API wrappers when tag rename/delete returns an error. Cleared on dismiss.
  const [rewriteError, setRewriteError] = useState<RewriteError | null>(null);
  const status = useMigrationStatus();
  // Phase 3 (Plan 03-07): the tree's selected-note id drives the
  // editor pane. setActiveNote is exposed via Sidebar.onSelectNote.
  const activeNoteId = useTreeStore((s) => s.activeNoteId);
  // Phase 5.5 — Plan 17 Bug A (UX-09): the App-level grid template's
  // first column must track the live sidebar width so the editor pane's
  // 1fr track reflows when the user drags the resize handle. The sidebar's
  // own <nav> already reads sidebarWidth (Sidebar.tsx:105) — App was
  // ignoring it, leaving the grid track hard-pinned at 260px. Subscribing
  // here mirrors that pattern. Selector is a primitive-number read, so a
  // re-render only fires when the persisted width actually changes.
  const sidebarWidth = useTreeStore((s) => s.sidebarWidth);
  // Phase 6 — Plan 06-07: right-rail state drives the third grid column.
  // Phase 6.6 — Plan 06.6-11 (D-36): when collapsed, rail column is 0px
  // (no more RAIL_COLLAPSED_WIDTH strip — that toggle is removed). TopBar
  // toggle re-opens the rail.
  const backlinksRailExpanded = useTreeStore((s) => s.backlinksRailExpanded);
  const backlinksRailWidth = useTreeStore((s) => s.backlinksRailWidth);
  // Phase 6.6 — Plan 06.6-11 (UX-CHROME-01): notes sidebar visibility.
  // When false, the sidebar column collapses to 0px.
  const notesSidebarVisible = useTreeStore((s) => s.notesSidebarVisible);

  // Phase 7 (Plan 07-12) — palette + cheat-sheet store slices.
  const paletteOpen = useTreeStore((s) => s.paletteOpen);
  const paletteMode = useTreeStore((s) => s.paletteMode);
  const setPaletteOpen = useTreeStore((s) => s.setPaletteOpen);
  const cheatSheetOpen = useTreeStore((s) => s.cheatSheetOpen);
  const setCheatSheetOpen = useTreeStore((s) => s.setCheatSheetOpen);

  // Phase 4 (Plan 04-05) — EditorPane handler ref (D-09: no new event bus).
  // App passes this ref to EditorPane; EditorPane writes its handlers on mount.
  // useSessionSync then dispatches WS events into EditorPane via this ref.
  const editorHandlersRef = useRef<EditorPaneHandlers | null>(null);

  // Phase 4 (Plan 04-05, UX-04) — session sync handlers.
  // onReindexStarted/Complete wire WS reindex events to the ReindexProgress
  // overlay phase state; onNoteUpdated/Deleted fan out to EditorPane via ref.
  const sessionSyncHandlers: SessionSyncHandlers = useMemo(
    () => ({
      onNoteUpdated: (p) => {
        editorHandlersRef.current?.onNoteUpdated(p);
      },
      onNoteDeleted: (p) => {
        editorHandlersRef.current?.onNoteDeleted(p);
      },
      onReindexStarted: () => {
        // UX-04: WS reindex:started → flip phase to 'starting' so the
        // ReindexProgress overlay appears while the server re-indexes.
        setReindexPhase("starting");
      },
      onReindexComplete: () => {
        // UX-04: reindex:complete → hide the overlay.
        setReindexPhase("idle");
      },
      // Plan 06-11 (D-33/D-35): links:rewritten from a cross-tab rename.
      // The payload's touched_note_ids indicates which notes were rewritten;
      // for v1 we do not check for partial failure here (the backend rolls
      // back atomically, so a links:rewritten event means success).
      // A future plan can add `success: false` to the payload shape and
      // show the error banner. For now this handler is a no-op placeholder
      // so the App.tsx wiring is in place and tests can verify the shape.
      onLinksRewritten: (_p) => {
        // Partial-failure detection deferred (D-37 full implementation).
        // When the backend adds `success: false` to WSLinksRewrittenPayload,
        // set rewriteError here: setRewriteError({ kind: "rename", missedCount: ... }).
        void _p;
      },
    }),
    [],
  );

  // Phase 4 (Plan 04-05): mount the WebSocket session-sync hook once at root.
  useSessionSync(sessionSyncHandlers);

  // Plan 03-20 Gap R2-4 — document-level F2 routing. See
  // handleAppF2KeyDown's JSDoc for the full rationale. The empty
  // dependency array is correct because the handler reads
  // useTreeStore.getState() at fire time — no stale-closure risk.
  useEffect(() => {
    document.addEventListener("keydown", handleAppF2KeyDown);
    document.addEventListener("keydown", handleAppPanelShortcuts);
    return () => {
      document.removeEventListener("keydown", handleAppF2KeyDown);
      document.removeEventListener("keydown", handleAppPanelShortcuts);
    };
  }, []);

  // Phase 7 (Plan 07-12) — capture-phase global keymap (D-22).
  // Third arg = true → capture phase REQUIRED so we intercept before CM6
  // processes the event (RESEARCH §Pitfall 5). Without capture=true, CM6
  // consumes Cmd+P before the window handler sees it and the browser
  // print dialog would race with the palette.
  //
  // Plan 07-16 (UAT #8/#9) — handleAppCmdB and handleAppCmdI added here.
  // They call preventDefault ONLY (no stopPropagation) so CM6's editor-level
  // capture-phase listener on cm-content still fires and toggles bold/italic.
  useEffect(() => {
    window.addEventListener("keydown", handleAppCmdP, true);
    window.addEventListener("keydown", handleAppCmdO, true);
    window.addEventListener("keydown", handleAppCmdShiftD, true);
    window.addEventListener("keydown", handleAppCmdSlash, true);
    // UAT #8/#9 fix: block browser/extension defaults for Cmd+B / Cmd+I.
    window.addEventListener("keydown", handleAppCmdB, true);
    window.addEventListener("keydown", handleAppCmdI, true);
    // Plan 07-40 (UAT-6): Cmd+Shift+F opens CommandMenu mode='search'.
    // (Reverses Plan 07-39's focus-bus dispatch.)
    window.addEventListener("keydown", handleAppCmdShiftF, true);
    return () => {
      window.removeEventListener("keydown", handleAppCmdP, true);
      window.removeEventListener("keydown", handleAppCmdO, true);
      window.removeEventListener("keydown", handleAppCmdShiftD, true);
      window.removeEventListener("keydown", handleAppCmdSlash, true);
      window.removeEventListener("keydown", handleAppCmdB, true);
      window.removeEventListener("keydown", handleAppCmdI, true);
      window.removeEventListener("keydown", handleAppCmdShiftF, true);
    };
  }, []);

  // Phase 7 (Plan 07-12) — bridge phase7 dispatch events to hook callables.
  // useDailyNote.openToday() needs to run inside the React tree (it calls
  // useToast which needs the ToastProvider context). The module-level handler
  // dispatches "openToday"; this subscription routes it to the hook method.
  const { openToday } = useDailyNote();
  useEffect(() => {
    return subscribePhase7((ev) => {
      if (ev === "openToday") void openToday();
    });
  }, [openToday]);

  const fireReindex = useCallback(async () => {
    setReindexPhase("running");
    setReindexError(undefined);

    const { data, error } = await postAdminReindex("full");

    if (error) {
      const msg =
        typeof error === "string"
          ? error
          : ((error as { message?: string })?.message ?? "rebuild failed");
      setReindexError(msg);
      setReindexPhase("error");
      return;
    }

    if (data) {
      setReindexPhase("completing");
      // 600ms success affordance, then unmount + refresh status. The
      // ReindexProgress component also has its own 1500ms onClose timer;
      // ours fires earlier (UI-SPEC §Surface 3 success transient is
      // ~600ms — Phase 2 explicitly), so this parent-driven transition
      // wins. The component's timer becomes a no-op because the parent
      // re-renders with phase=idle before 1500ms elapses.
      window.setTimeout(() => {
        setReindexPhase("idle");
        void status.refresh();
      }, SUCCESS_TRANSIENT_MS);
    }
  }, [status]);

  const onConfirm = useCallback(() => {
    setDialogOpen(false);
    void fireReindex();
  }, [fireReindex]);

  const onCloseOverlay = useCallback(() => {
    // Called from ReindexProgress when:
    //   - the user clicks "Close" in the error state
    //   - the component's own onClose timer fires (after the parent has
    //     usually already transitioned to idle via SUCCESS_TRANSIENT_MS;
    //     this is the late-arriving safety net)
    setReindexPhase("idle");
    void status.refresh();
  }, [status]);

  const reindexing = reindexPhase !== "idle";

  // Plan 07-17 (UAT #3 fix): the real create helper, same one SidebarToolbar uses.
  // Must be called inside the component body (hook rule); captured in commandActions dep array.
  const { createNoteAt } = useTreeCreateActions();

  // Plan 08-06 (D-26 / SHARE-01 Mount C): shared reveal hook for the
  // palette "Share" command + the file-tree wire used to resolve
  // activeNoteId → path at call time. The hook is a no-op when called
  // without an active note (handled below — onShareRevealCurrentNote
  // stays undefined in that case so the palette renders it dimmed).
  const { reveal } = useReveal();
  const { tree } = useFileTree();

  // Phase 7 (Plan 07-12) — CommandActions for CommandMenu.
  // Each action is wired to an existing hook or store setter.
  // Stable reference via useMemo (actions only change if dependencies change).
  const commandActions: CommandActions = useMemo(
    () => ({
      // "New note" — create at root (empty string = vault root).
      // Dispatches via the store's startDraftCreate flow; a future refactor
      // could expose useTreeCreateActions.createNoteAt here, but triggering
      // root-level creation via store is the v1 path: the Sidebar toolbar's
      // "New Note" button does the same via useTreeCreateActions internally.
      // For v1 we focus the sidebar + set a store flag so the user knows
      // where to look. Simplest working implementation: open the palette in
      // notes mode (so the user can pick a note) while queuing the create.
      // Actually — the cleanest v1 behavior is to just close the palette
      // and let the user use the sidebar toolbar. Documented as intentional.
      onNewNote: () => {
        // UAT #3 fix: invoke the real create helper (same one SidebarToolbar uses).
        // v1 trade-off: palette commands always create at vault root for predictability.
        // Selection-aware placement remains a sidebar feature (Sidebar.tsx handleNewNote).
        void createNoteAt("");
        setPaletteOpen(false);
      },

      // "Save" — CM6 editor dispatch: trigger a save via EditorPane's
      // internal Cmd+S handler. Dispatching a synthetic keyboard event
      // is the cleanest bridge without coupling to EditorPane internals.
      // Note: CM6 owns Cmd+S in the capture phase; for the command palette
      // we fire it at the document level (bubble phase) so CM6's listener
      // picks it up when the editor is mounted.
      onSave: () => {
        setPaletteOpen(false);
        const saveEvent = new KeyboardEvent("keydown", {
          key: "s",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(saveEvent);
      },

      // "Today" — same as Cmd+Shift+D.
      onToday: () => {
        setPaletteOpen(false);
        void openToday();
      },

      // "Switch / search notes" — flip palette mode to notes WITHOUT closing.
      // UAT #5 fix: CommandMenu.activate honors closeOnExecute=false for
      // switch-note (Plan 07-17 Task 2), so the palette stays open and
      // re-renders the notes-mode list.
      onSwitchNote: () => {
        useTreeStore.getState().setPaletteMode("notes");
      },

      // "Toggle theme" — getCurrentTheme + applyTheme directly, or dispatch
      // through the existing setTheme path. Since useTheme is not available
      // here without adding another hook call, we manipulate data-theme
      // directly (same as the theme-bootstrap mechanism) and let useTheme
      // sync on the next config load. This is a v1 trade-off — acceptable
      // per D-47 "synchronous, no inline confirmations".
      onToggleTheme: () => {
        const current =
          document.documentElement.getAttribute("data-theme") ?? "dark";
        const next = current === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        try {
          localStorage.setItem("jasper:theme-bootstrap", next);
        } catch {
          /* private mode — fall through */
        }
        setPaletteOpen(false);
      },

      // "Refresh index" — trigger an incremental reindex without showing the
      // full ReindexProgress overlay (palette command is non-destructive quick
      // path). Fires in background; status bar picks up WS events.
      onRefreshIndex: () => {
        setPaletteOpen(false);
        void postAdminReindex("incremental");
      },

      // "Reset and rebuild…" — open the existing ResetAndRebuildDialog.
      onRebuildIndex: () => {
        setPaletteOpen(false);
        setDialogOpen(true);
      },

      // "Show keyboard shortcuts" — open the cheat-sheet dialog.
      onShowShortcuts: () => {
        setPaletteOpen(false);
        setCheatSheetOpen(true);
      },

      // Plan 08-06 (D-26 / SHARE-01 Mount C): "Show current note in file
      // manager". onShareRevealCurrentNote is undefined when no note is
      // active so the palette renders the entry dimmed (UI-SPEC §Surface 4
      // Mount C). When set, it resolves the active note's path from the
      // live wire tree and dispatches the reveal — closing the palette
      // first so the toast surface is unobstructed.
      onShareRevealCurrentNote:
        activeNoteId != null
          ? () => {
              const path = findActiveNotePath(tree?.root ?? [], activeNoteId);
              setPaletteOpen(false);
              if (path) void reveal(path);
            }
          : undefined,
    }),
    [
      openToday,
      setPaletteOpen,
      setCheatSheetOpen,
      createNoteAt,
      activeNoteId,
      reveal,
      tree,
    ],
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // Lock to viewport height (was minHeight, which let children
        // expand the document past the viewport — observed: editor
        // pane growing past 10kpx forced a document scrollbar with
        // mostly-empty space below the active note). Sidebar tree
        // and editor each handle their own internal scroll inside
        // this fixed-height shell.
        height: "100vh",
        overflow: "hidden",
      }}
    >
      <MigrationBanner
        onResetConfirm={() => setDialogOpen(true)}
        status={status}
      />
      {/* Plan 06-11 (D-36/D-37): rename/tag-rewrite rollback error banner.
          Stacks below MigrationBanner when both are visible simultaneously. */}
      <RenameRewriteErrorBanner
        state={rewriteError}
        onDismiss={() => setRewriteError(null)}
      />
      <ResetAndRebuildDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConfirm={onConfirm}
      />
      {/* Phase 7 (Plan 07-12) — Command palette + cheat-sheet dialogs.
          Portal siblings to ResetAndRebuildDialog (Radix manages portals).
          paletteOpen / cheatSheetOpen are store slices set by the capture-phase
          keydown handlers (handleAppCmdP/O/Slash). CommandActions wire all 9
          registered commands to existing hooks and store setters. */}
      <CommandMenu
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        mode={paletteMode}
        actions={commandActions}
      />
      <KeyboardShortcutsDialog
        open={cheatSheetOpen}
        onOpenChange={setCheatSheetOpen}
      />
      {/* Phase 6.6 — Plan 06.6-11 (UX-CHROME-01/02): two-row grid.
          Row 1: TopBar (gridColumn:2 only). Row 2: EditorPane (gridColumn:2).
          Sidebar and RightRail span both rows (gridRow: "1 / 3").
          StatusBar sits below the grid as a direct flex child — full app width.
          RESEARCH §Option A: two-row grid avoids position:sticky inside
          overflow:hidden (Pitfall 1). */}
      <div
        style={{
          display: "grid",
          // Plan 17 Bug A (UX-09): track sidebarWidth in the grid template
          // so the editor pane (1fr) reflows when the resize handle drags.
          // Phase 6.6 (D-36): when rail is collapsed, column is 0px (no toggle strip).
          // Phase 6.6: when sidebar is hidden, column is 0px.
          gridTemplateColumns: `${notesSidebarVisible ? sidebarWidth : 0}px 1fr ${backlinksRailExpanded ? backlinksRailWidth : 0}px`,
          // Phase 6.6 — two-row grid: row 1 for TopBar (auto height),
          // row 2 for EditorPane (fills remaining space).
          gridTemplateRows: "auto minmax(0, 1fr)",
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {/* TopBar: row 1, column 2 — editor pane width only (D-01) */}
        <TopBar style={{ gridRow: "1", gridColumn: "2" }} />

        {/* Sidebar: spans both rows (gridRow 1/3) — column 1 */}
        <Sidebar
          style={{ gridRow: "1 / 3", gridColumn: "1" }}
          onSelectNote={(id) => useTreeStore.getState().setActiveNote(id)}
        />

        {/* Editor/reindex: row 2, column 2 */}
        {reindexing ? (
          <ReindexProgress
            style={{ gridRow: "2", gridColumn: "2" }}
            phase={reindexPhase}
            errorMessage={reindexError}
            onRetry={fireReindex}
            onClose={onCloseOverlay}
          />
        ) : (
          <EditorPane
            style={{ gridRow: "2", gridColumn: "2" }}
            noteId={activeNoteId}
            reindexing={false}
            editorHandlersRef={editorHandlersRef}
          />
        )}

        {/* Phase 6.5 — Plan 06.5-04: right rail two-panel layout (D-01/D-03).
            Phase 6.6 — spans both rows (gridRow 1/3) — column 3 */}
        <RightRail
          style={{ gridRow: "1 / 3", gridColumn: "3" }}
          activeNoteId={activeNoteId}
        />
      </div>
      {/* Phase 6.6 — StatusBar: below the grid, full app width (D-06) */}
      <StatusBar />
    </div>
  );
}

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

import { BacklinksColumn } from "./components/BacklinksColumn";
import { EditorPane, type EditorPaneHandlers } from "./components/EditorPane";
import { MigrationBanner } from "./components/MigrationBanner";
import { ReindexProgress } from "./components/ReindexProgress";
import { ResetAndRebuildDialog } from "./components/ResetAndRebuildDialog";
import { Sidebar } from "./components/Sidebar";
import { ToastProvider } from "./components/Toast";
import { postAdminReindex } from "./lib/adminApi";
import { useMigrationStatus } from "./lib/useMigrationStatus";
import { useSessionSync, type SessionSyncHandlers } from "./lib/useSessionSync";
import { useTreeStore } from "./lib/useTreeStore";

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
    return () => {
      document.removeEventListener("keydown", handleAppF2KeyDown);
    };
  }, []);

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

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
      }}
    >
      <MigrationBanner
        onResetConfirm={() => setDialogOpen(true)}
        status={status}
      />
      <ResetAndRebuildDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConfirm={onConfirm}
      />
      <div
        style={{
          display: "grid",
          // Plan 17 Bug A (UX-09): track sidebarWidth in the grid template
          // so the editor pane (1fr) reflows when the resize handle drags.
          // Previously hard-coded to "260px 1fr 0" — see 05.5-17a-INVESTIGATION.md.
          gridTemplateColumns: `${sidebarWidth}px 1fr 0`,
          flex: 1,
        }}
      >
        <Sidebar
          onSelectNote={(id) => useTreeStore.getState().setActiveNote(id)}
        />
        {reindexing ? (
          <ReindexProgress
            phase={reindexPhase}
            errorMessage={reindexError}
            onRetry={fireReindex}
            onClose={onCloseOverlay}
          />
        ) : (
          <EditorPane
            noteId={activeNoteId}
            reindexing={false}
            editorHandlersRef={editorHandlersRef}
          />
        )}
        <BacklinksColumn />
      </div>
    </div>
  );
}

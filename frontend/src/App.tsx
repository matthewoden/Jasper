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
import { EditorPane, type EditorPaneHandlers } from "./components/EditorPane";
import { MigrationBanner } from "./components/MigrationBanner";
import { RenameRewriteErrorBanner, type RewriteError } from "./components/RenameRewriteErrorBanner";
import { ReindexProgress } from "./components/ReindexProgress";
import { ResetAndRebuildDialog } from "./components/ResetAndRebuildDialog";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TopBar } from "./components/TopBar";
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

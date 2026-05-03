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

import { useCallback, useState } from "react";

import { BacklinksColumn } from "./components/BacklinksColumn";
import { EditorPane } from "./components/EditorPane";
import { MigrationBanner } from "./components/MigrationBanner";
import { ReindexProgress } from "./components/ReindexProgress";
import { ResetAndRebuildDialog } from "./components/ResetAndRebuildDialog";
import { Sidebar } from "./components/Sidebar";
import { ToastProvider } from "./components/Toast";
import { postAdminReindex } from "./lib/adminApi";
import { useMigrationStatus } from "./lib/useMigrationStatus";

// W-4 LOCKED: the parent owns the phase enum; ReindexProgress is purely
// presentational. 'starting' is reserved for Phase 4 (when WS-driven
// reindex pre-flight produces a "starting" event before "running"); Phase 2
// transitions directly idle → running on confirm.
type ReindexPhase =
  | "idle"
  | "starting"
  | "running"
  | "completing"
  | "error";

const SUCCESS_TRANSIENT_MS = 600;

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
          gridTemplateColumns: "260px 1fr 0",
          flex: 1,
        }}
      >
        <Sidebar />
        {reindexing ? (
          <ReindexProgress
            phase={reindexPhase}
            errorMessage={reindexError}
            onRetry={fireReindex}
            onClose={onCloseOverlay}
          />
        ) : (
          <EditorPane reindexing={false} />
        )}
        <BacklinksColumn />
      </div>
    </div>
  );
}

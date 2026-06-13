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
import { vaultApi } from "./lib/vaultApi";
import { VaultPicker } from "./components/VaultPicker";
import { switchVaultCommand } from "./lib/commands/registerVaultCommands";

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
import { useDeepLink } from "./lib/useDeepLink";
import { useMigrationStatus } from "./lib/useMigrationStatus";
import { useReveal } from "./lib/useReveal";
import { useSessionSync, type SessionSyncHandlers } from "./lib/useSessionSync";
import { useVaultSwitch } from "./lib/useVaultSwitch";
import { VaultSwitchOverlay } from "./components/VaultSwitchOverlay";
import { useTreeStore } from "./lib/useTreeStore";
import {
  handleAppCmdB,
  handleAppCmdI,
  handleAppCmdO,
  handleAppCmdP,
  handleAppCmdShiftD,
  handleAppCmdShiftF,
  handleAppCmdSlash,
  handleAppF2KeyDown,
  handleAppPanelShortcuts,
  subscribePhase7,
} from "./lib/appShortcuts";
import { useTreeCreateActions } from "./lib/useTreeCreateActions";
import { useFileTree } from "./lib/useFileTree";
import type { CommandActions } from "./lib/useCommandPalette";
import type { TreeNode } from "./lib/treeApi";


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


type ReindexPhase =
  | "idle"
  | "starting"
  | "running"
  | "completing"
  | "error";

const SUCCESS_TRANSIENT_MS = 600;


/**
 * Boot detection gate (Plan 08-17c).
 *
 * Reads GET /vault/current on mount. If null, renders <VaultPicker mode="boot">
 * (the picker IS the page). If a vault is open, renders the normal app shell.
 * Errors err on the side of showing the picker to avoid a blank-page state.
 *
 * Implementation note: the boot check is local (127.0.0.1) and resolves in a
 * few ms. We render nothing during the check rather than optimistically mounting
 * AppInner — the prior optimistic mount spawned the WebSocket against
 * /api/v1/ws which is dormant in no-vault mode, producing console errors that
 * confused first-run UAT. The brief blank is preferable to a torn-mount race.
 */
type BootState = "loading" | "noVault" | "vaultOpen";

function BootGate() {
  const [state, setState] = useState<BootState>("loading");

  useEffect(() => {
    vaultApi
      .getCurrent()
      .then((current) => {
        setState(current === null ? "noVault" : "vaultOpen");
      })
      .catch(() => setState("noVault"));
  }, []);

  if (state === "loading") return null;
  if (state === "noVault") return <VaultPicker mode="boot" />;
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}


export function AppShell() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}

export default function App() {
  return <BootGate />;
}


export function AppInner() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reindexPhase, setReindexPhase] = useState<ReindexPhase>("idle");
  const [reindexError, setReindexError] = useState<string | undefined>();
  const [rewriteError, setRewriteError] = useState<RewriteError | null>(null);
  const status = useMigrationStatus();
  const activeNoteId = useTreeStore((s) => s.activeNoteId);
  const sidebarWidth = useTreeStore((s) => s.sidebarWidth);
  const backlinksRailExpanded = useTreeStore((s) => s.backlinksRailExpanded);
  const backlinksRailWidth = useTreeStore((s) => s.backlinksRailWidth);
  const notesSidebarVisible = useTreeStore((s) => s.notesSidebarVisible);

  const paletteOpen = useTreeStore((s) => s.paletteOpen);
  const paletteMode = useTreeStore((s) => s.paletteMode);
  const setPaletteOpen = useTreeStore((s) => s.setPaletteOpen);
  const cheatSheetOpen = useTreeStore((s) => s.cheatSheetOpen);
  const setCheatSheetOpen = useTreeStore((s) => s.setCheatSheetOpen);

  const editorHandlersRef = useRef<EditorPaneHandlers | null>(null);

  const { markSwitching, markSwitched, switching: vaultSwitching, targetName: vaultSwitchTargetName } = useVaultSwitch();

  const sessionSyncHandlers: SessionSyncHandlers = useMemo(
    () => ({
      onNoteUpdated: (p) => {
        editorHandlersRef.current?.onNoteUpdated(p);
      },
      onNoteDeleted: (p) => {
        editorHandlersRef.current?.onNoteDeleted(p);
      },
      onReindexStarted: () => {
        setReindexPhase("starting");
      },
      onReindexComplete: () => {
        setReindexPhase("idle");
      },
      onLinksRewritten: (p) => {
        if (p.error) {
          setRewriteError({ kind: "rename", missedCount: p.touched_note_ids?.length });
        }
      },
      onVaultSwitching: (p) => {
        markSwitching(p.target_display_name);
      },
      onVaultSwitched: () => {
        markSwitched();
      },
    }),
    [markSwitching, markSwitched],
  );

  useSessionSync(sessionSyncHandlers);

  useEffect(() => {
    document.addEventListener("keydown", handleAppF2KeyDown);
    document.addEventListener("keydown", handleAppPanelShortcuts);
    return () => {
      document.removeEventListener("keydown", handleAppF2KeyDown);
      document.removeEventListener("keydown", handleAppPanelShortcuts);
    };
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleAppCmdP, true);
    window.addEventListener("keydown", handleAppCmdO, true);
    window.addEventListener("keydown", handleAppCmdShiftD, true);
    window.addEventListener("keydown", handleAppCmdSlash, true);
    window.addEventListener("keydown", handleAppCmdB, true);
    window.addEventListener("keydown", handleAppCmdI, true);
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
    setReindexPhase("idle");
    void status.refresh();
  }, [status]);

  const reindexing = reindexPhase !== "idle";

  const { createNoteAt } = useTreeCreateActions();

  const { reveal } = useReveal();
  const { tree } = useFileTree();

  useDeepLink(tree !== null);

  const commandActions: CommandActions = useMemo(
    () => ({
      onNewNote: () => {
        void createNoteAt("");
        setPaletteOpen(false);
      },

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

      onToday: () => {
        setPaletteOpen(false);
        void openToday();
      },

      onSwitchNote: () => {
        useTreeStore.getState().setPaletteMode("notes");
      },

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

      onRefreshIndex: () => {
        setPaletteOpen(false);
        void postAdminReindex("incremental");
      },

      onRebuildIndex: () => {
        setPaletteOpen(false);
        setDialogOpen(true);
      },

      onShowShortcuts: () => {
        setPaletteOpen(false);
        setCheatSheetOpen(true);
      },

      onShareRevealCurrentNote:
        activeNoteId != null
          ? () => {
              const path = findActiveNotePath(tree?.root ?? [], activeNoteId);
              setPaletteOpen(false);
              if (path) void reveal(path);
            }
          : undefined,

      onSwitchVault: () => {
        setPaletteOpen(false);
        switchVaultCommand();
      },
    }),
    [
      openToday,
      setPaletteOpen,
      setCheatSheetOpen,
      createNoteAt,
      activeNoteId,
      reveal,
      tree,
      // switchVaultCommand is a stable module-level function — no dependency needed,
      // but including it keeps ESLint's exhaustive-deps rule satisfied.
    ],
  );

  return (
    <>
    {/* Plan 08-17d (V4): vault-switch overlay. Mounts above everything on
        vault.switching WS event; SPA reloads on vault.switched (or 10s failsafe). */}
    {vaultSwitching && (
      <VaultSwitchOverlay targetName={vaultSwitchTargetName} />
    )}
    <div
      style={{
        display: "flex",
        flexDirection: "column",
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
          gridTemplateColumns: `${notesSidebarVisible ? sidebarWidth : 0}px 1fr ${backlinksRailExpanded ? backlinksRailWidth : 0}px`,
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
    </>
  );
}

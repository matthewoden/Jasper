/**
 * App shell. ReindexProgress is presentational; AppInner owns the reindex
 * phase enum and drives the state machine. W-4 lock: no internal phase-state
 * in ReindexProgress.
 */

import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { vaultApi } from "./lib/vaultApi";
import { VaultPicker } from "./components/VaultPicker";
import {
  switchVaultCommand,
  toggleZenCommand,
} from "./lib/commands/registerVaultCommands";

import { RightRail } from "./components/RightRail";
import { CommandMenu } from "./components/CommandMenu";
import { EditorPane, type EditorPaneHandlers } from "./components/EditorPane";
import { FlushConfirmDialog } from "./components/FlushConfirmDialog";
import { KeyboardShortcutsDialog } from "./components/KeyboardShortcutsDialog";
import { McpUnavailableBanner } from "./components/McpUnavailableBanner";
import { MigrationBanner } from "./components/MigrationBanner";
import { RenameRewriteErrorBanner, type RewriteError } from "./components/RenameRewriteErrorBanner";
import { ReindexProgress } from "./components/ReindexProgress";
import { ResetAndRebuildDialog } from "./components/ResetAndRebuildDialog";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TabStrip } from "./components/TabStrip";
import { ActivityRibbon } from "./components/ActivityRibbon";
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
  pruneTabsForMissingNotes,
  useTabStore,
} from "./lib/useTabStore";
import { usePaneStore } from "./lib/usePaneStore";
import { useTreeMutations } from "./lib/useTreeMutations";
import {
  handleAppAltT,
  handleAppCmdB,
  handleAppCmdDot,
  handleAppCmdI,
  handleAppCmdK,
  handleAppCmdO,
  handleAppCmdP,
  handleAppCmdShiftD,
  handleAppCmdShiftF,
  handleAppCmdSlash,
  handleAppF2KeyDown,
  handleAppPanelShortcuts,
  subscribePhase7,
} from "./lib/appShortcuts";
import {
  siblingNamesForCreate,
  useTreeCreateActions,
} from "./lib/useTreeCreateActions";
import { nextUntitledName } from "./lib/nextUntitledName";
import { shouldPromoteActiveNote } from "./lib/promoteActiveNote";
import { useFileTree } from "./lib/useFileTree";
import { useConfig } from "./lib/useConfig";
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

/** Live note title by UUID for a tab pill (TAB-12 — follows server-side renames). */
function findNoteTitle(
  nodes: ReadonlyArray<TreeNode>,
  id: string,
): string | null {
  for (const node of nodes) {
    if (node.kind === "note" && node.id === id) return node.title;
    if (node.kind === "folder" && Array.isArray(node.children)) {
      const found = findNoteTitle(node.children, id);
      if (found !== null) return found;
    }
  }
  return null;
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Closing the final tab blanks the editor (BUG 3b — VS Code behavior): clear the
 * legacy activeNoteId so the note does not reappear in the tab-less fallback pane.
 * Tied to the close user-action path, not a !hasTabs effect (which would race).
 */
function clearActiveOnEmptyTabs(): void {
  if (useTabStore.getState().tabs.length === 0) {
    useTreeStore.getState().setActiveNote(null);
  }
}

/** Collect every note UUID present in the tree (for tab pruning). */
function collectNoteIds(nodes: ReadonlyArray<TreeNode>, acc: Set<string>): void {
  for (const node of nodes) {
    if (node.kind === "note") acc.add(node.id);
    else if (node.kind === "folder" && Array.isArray(node.children)) {
      collectNoteIds(node.children, acc);
    }
  }
}


type ReindexPhase =
  | "idle"
  | "starting"
  | "running"
  | "completing"
  | "error";

const SUCCESS_TRANSIENT_MS = 600;


/**
 * Reads GET /vault/current on mount. Renders nothing during the check rather
 * than optimistically mounting AppInner — an optimistic mount would open the
 * WebSocket while no vault is active, producing console errors. The brief
 * blank is preferable to a torn-mount race.
 */
type BootState = "loading" | "noVault" | "vaultOpen";

function BootGate() {
  const [state, setState] = useState<BootState>("loading");
  const [vaultPath, setVaultPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    vaultApi
      .getCurrent()
      .then((current) => {
        if (cancelled) return;
        if (current === null) {
          setState("noVault");
        } else {
          setVaultPath(current.path);
          setState("vaultOpen");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setState("noVault");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "loading") return null;
  if (state === "noVault") return <VaultPicker mode="boot" />;
  return (
    <ToastProvider>
      <AppInner vaultPath={vaultPath} />
    </ToastProvider>
  );
}


// Test-only composition: bypasses BootGate's vault resolution so shell tests
// can mount AppInner directly. Production always enters through <App/>.
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


interface AppInnerProps {
  /** Stable vault id for per-vault tab persistence; null in the AppShell test path. */
  vaultPath?: string | null;
}

export function AppInner({ vaultPath = null }: AppInnerProps = {}) {
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
  const zen = useTreeStore((s) => s.zen);

  const paletteOpen = useTreeStore((s) => s.paletteOpen);
  const paletteMode = useTreeStore((s) => s.paletteMode);
  const setPaletteOpen = useTreeStore((s) => s.setPaletteOpen);
  const cheatSheetOpen = useTreeStore((s) => s.cheatSheetOpen);
  const setCheatSheetOpen = useTreeStore((s) => s.setCheatSheetOpen);

  // --- Tab system state (Plan 05) ----------------------------------------
  const tabs = useTabStore((s) => s.tabs);
  const tabActiveTabId = useTabStore((s) => s.activeTabId);
  const deletedTabIds = useTabStore((s) => s.deletedTabIds);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const closeTab = useTabStore((s) => s.closeTab);
  const reorderTabs = useTabStore((s) => s.reorderTabs);

  const activeTab = tabs.find((t) => t.id === tabActiveTabId) ?? null;

  // One handler ref + one flush ref per open tab so WS fan-out (D-01) and
  // flush-on-close (TAB-13) address each keep-alive EditorPane individually.
  const tabHandlerRefs = useRef<
    Record<string, MutableRefObject<EditorPaneHandlers | null>>
  >({});
  const tabFlushRefs = useRef<
    Record<string, MutableRefObject<{ flush: () => Promise<void> } | null>>
  >({});

  // The zero-tab fallback pane gets its own handler ref so WS note.updated /
  // note.deleted still reach it (silent reload + banners) while no tab is
  // open — e.g. a deep-linked note that failed tab promotion (IN-04).
  const fallbackHandlerRef = useRef<EditorPaneHandlers | null>(null);

  // Each render, ensure a ref pair exists for every open tab and drop refs for
  // tabs that have closed (PATTERNS Section 2).
  for (const tab of tabs) {
    if (!tabHandlerRefs.current[tab.id]) {
      tabHandlerRefs.current[tab.id] = { current: null };
    }
    if (!tabFlushRefs.current[tab.id]) {
      tabFlushRefs.current[tab.id] = { current: null };
    }
  }
  for (const id of Object.keys(tabHandlerRefs.current)) {
    if (!tabs.some((t) => t.id === id)) {
      delete tabHandlerRefs.current[id];
      delete tabFlushRefs.current[id];
    }
  }

  // Flush-confirm dialog state: set when an on-close flush rejects (D-04).
  const [flushConfirm, setFlushConfirm] = useState<{
    tabId: string;
    filename: string;
  } | null>(null);

  const { config } = useConfig();

  useEffect(() => {
    if (!config) return;
    document.documentElement.style.setProperty(
      "--editor-font-size",
      `${config.editor.fontSize}px`,
    );
    document.documentElement.style.setProperty(
      "--editor-line-height",
      `${config.editor.lineHeight}`,
    );
  }, [config?.editor.fontSize, config?.editor.lineHeight]);

  const { markSwitching, markSwitched, switching: vaultSwitching, targetName: vaultSwitchTargetName } = useVaultSwitch();

  const sessionSyncHandlers: SessionSyncHandlers = useMemo(
    () => ({
      onNoteUpdated: (p) => {
        // Fan out to every open tab's editor; each EditorPane's internal
        // p.id !== noteIdRef guard ignores events for other notes (D-01).
        for (const ref of Object.values(tabHandlerRefs.current)) {
          ref.current?.onNoteUpdated(p);
        }
        fallbackHandlerRef.current?.onNoteUpdated(p);
      },
      onNoteDeleted: (p) => {
        for (const ref of Object.values(tabHandlerRefs.current)) {
          ref.current?.onNoteDeleted(p);
        }
        fallbackHandlerRef.current?.onNoteDeleted(p);
        // Freeze the matching tab read-only for the rest of the session (D-10).
        useTabStore.getState().markDeleted(p.id);
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
    window.addEventListener("keydown", handleAppCmdK, true);
    window.addEventListener("keydown", handleAppCmdDot, true);
    window.addEventListener("keydown", handleAppCmdShiftD, true);
    window.addEventListener("keydown", handleAppCmdSlash, true);
    window.addEventListener("keydown", handleAppCmdB, true);
    window.addEventListener("keydown", handleAppCmdI, true);
    window.addEventListener("keydown", handleAppCmdShiftF, true);
    window.addEventListener("keydown", handleAppAltT, true);
    return () => {
      window.removeEventListener("keydown", handleAppCmdP, true);
      window.removeEventListener("keydown", handleAppCmdO, true);
      window.removeEventListener("keydown", handleAppCmdK, true);
      window.removeEventListener("keydown", handleAppCmdDot, true);
      window.removeEventListener("keydown", handleAppCmdShiftD, true);
      window.removeEventListener("keydown", handleAppCmdSlash, true);
      window.removeEventListener("keydown", handleAppCmdB, true);
      window.removeEventListener("keydown", handleAppCmdI, true);
      window.removeEventListener("keydown", handleAppCmdShiftF, true);
      window.removeEventListener("keydown", handleAppAltT, true);
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
  const { createNote } = useTreeMutations();

  // Collision-safe default title for a new note in `parent`: reuses the same
  // pattern as the tree toolbar so a second + / open-to-the-right in a folder
  // already holding "untitled.md" yields "untitled 1" instead of a 409.
  const uniqueUntitledTitle = useCallback(
    (parent: string): string =>
      nextUntitledName(siblingNamesForCreate(tree, parent, "note"), "untitled"),
    [tree],
  );

  useDeepLink(tree !== null);

  // --- Tab ↔ tree synchronization & persistence (Plan 05) ----------------

  // Keep useTreeStore.activeNoteId mirrored to the active tab so the tree
  // highlight, breadcrumbs, and backlinks rail follow tab switches (RESEARCH OQ#3).
  // Only mirror while at least one tab is open: with no tabs the legacy
  // activeNoteId drives the single fallback pane and must be left untouched.
  const activeTabNoteId = activeTab?.noteId ?? null;
  const hasTabs = tabs.length > 0;
  useEffect(() => {
    if (!hasTabs) return;
    useTreeStore.getState().setActiveNote(activeTabNoteId);
  }, [activeTabNoteId, hasTabs]);

  // Hydrate per-vault tab state once the vault is resolved (D-08/D-11). The tab
  // key is vault-scoped, so this can only run after BootGate hands us the path.
  useEffect(() => {
    if (vaultPath === null) return;
    useTabStore.getState().initForVault(vaultPath);
  }, [vaultPath]);

  // After the first tree fetch, drop any persisted tab whose note no longer
  // exists in this vault (deleted-on-disk, or a stale UUID from another vault).
  // Deleted-session tabs are retained by pruneTabsForMissingNotes itself (D-10).
  const prunedRef = useRef(false);
  useEffect(() => {
    if (prunedRef.current || tree === null) return;
    prunedRef.current = true;
    const notes = new Set<string>();
    collectNoteIds(tree.root, notes);
    pruneTabsForMissingNotes(notes);
    // Load-time promotion (BUG 3a): a legacy single-open note (persisted
    // activeNoteId) with zero hydrated tabs becomes a real tab. Read tabs.length
    // AFTER prune so persisted tabs win and a pruned-away active note is not
    // re-promoted. prunedRef gates this to once per mount (= once per vault load,
    // since vault switch reloads the page) — no separate !hasTabs effect that
    // would race the activeTab↔activeNoteId mirror.
    if (
      shouldPromoteActiveNote(
        useTabStore.getState().tabs.length,
        useTreeStore.getState().activeNoteId,
        notes,
      )
    ) {
      useTabStore.getState().openTab(useTreeStore.getState().activeNoteId!);
    }
  }, [tree]);

  // titleForTab — live note title by UUID (TAB-12). Falls back to a stable
  // placeholder when the tree hasn't loaded the note yet.
  const titleForTab = useCallback(
    (noteId: string): string =>
      (tree && findNoteTitle(tree.root, noteId)) ?? "Untitled",
    [tree],
  );

  // flushAndClose — persist a closing tab's pending edits before removal (TAB-13).
  // A deleted tab is frozen read-only, so it has nothing to flush (D-10).
  // On flush rejection, surface the confirm dialog rather than dropping edits (D-04).
  const flushAndClose = useCallback(
    async (tabId: string): Promise<void> => {
      const tab = useTabStore.getState().tabs.find((t) => t.id === tabId);
      if (tab === undefined) return;
      if (useTabStore.getState().deletedTabIds.has(tab.noteId)) {
        closeTab(tabId);
        clearActiveOnEmptyTabs();
        return;
      }
      try {
        await tabFlushRefs.current[tabId]?.current?.flush();
        closeTab(tabId);
        clearActiveOnEmptyTabs();
      } catch {
        const filename = titleForTab(tab.noteId);
        setFlushConfirm({ tabId, filename });
        // Re-throw so a sequential bulk loop pauses on the unresolved decision.
        throw new Error("flush failed");
      }
    },
    [closeTab, titleForTab],
  );

  // Bulk closes run SEQUENTIALLY (Pitfall 7 — never Promise.all): each dirty tab
  // flushes and resolves before the next starts, so the confirm dialog (if any)
  // is handled one tab at a time. A rejected flush aborts the remaining loop.
  const closeOthers = useCallback(
    (tabId: string): void => {
      void (async () => {
        const targets = useTabStore
          .getState()
          .tabs.filter((t) => t.id !== tabId)
          .map((t) => t.id);
        for (const id of targets) {
          try {
            await flushAndClose(id);
          } catch {
            return; // stop on the first unresolved flush (dialog now open)
          }
        }
      })();
    },
    [flushAndClose],
  );

  const closeToRight = useCallback(
    (tabId: string): void => {
      void (async () => {
        const all = useTabStore.getState().tabs;
        const idx = all.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        const targets = all.slice(idx + 1).map((t) => t.id);
        for (const id of targets) {
          try {
            await flushAndClose(id);
          } catch {
            return;
          }
        }
      })();
    },
    [flushAndClose],
  );

  // onOpenRight — create a new note beside the context tab's note and open it.
  const openRight = useCallback(
    (tabId: string): void => {
      const tab = useTabStore.getState().tabs.find((t) => t.id === tabId);
      if (tab === undefined || tree === null) return;
      const notePath = findActiveNotePath(tree.root, tab.noteId);
      const parent = notePath !== null ? parentDir(notePath) : "";
      void (async () => {
        try {
          const created = await createNote(parent, uniqueUntitledTitle(parent));
          useTabStore.getState().openTab(created.id);
        } catch {
          // Creation failures surface via the shared tree-mutation toast path;
          // nothing tab-specific to recover here.
        }
      })();
    },
    [tree, createNote, uniqueUntitledTitle],
  );

  // Shared create-then-open handler for both new-tab affordances (TAB-14): the
  // TabStrip + button and the Alt+T shortcut. Mirrors openRight but targets the
  // ACTIVE tab's note (parent dir), falling back to the vault root "" when no
  // tab is active — that fallback is the zero-tab bootstrap path.
  const newTab = useCallback((): void => {
    const active = useTabStore.getState();
    const activeTabRow =
      active.tabs.find((t) => t.id === active.activeTabId) ?? null;
    const notePath =
      activeTabRow !== null && tree !== null
        ? findActiveNotePath(tree.root, activeTabRow.noteId)
        : null;
    const parent = notePath !== null ? parentDir(notePath) : "";
    void (async () => {
      try {
        const created = await createNote(parent, uniqueUntitledTitle(parent));
        useTabStore.getState().openTab(created.id);
      } catch {
        // Creation failures surface via the shared tree-mutation toast path.
      }
    })();
  }, [tree, createNote, uniqueUntitledTitle]);

  useEffect(() => {
    return subscribePhase7((ev) => {
      if (ev === "newTab") newTab();
    });
  }, [newTab]);

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

      onToggleZen: () => {
        setPaletteOpen(false);
        toggleZenCommand();
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
      // switchVaultCommand/toggleZenCommand are stable module-level fns; included to satisfy exhaustive-deps.
    ],
  );

  return (
    <>
    {/* Vault-switch overlay: mounts above everything on vault.switching WS event;
        SPA reloads on vault.switched (or 10s failsafe). */}
    {vaultSwitching && (
      <VaultSwitchOverlay targetName={vaultSwitchTargetName} />
    )}
    <div
      data-zen={zen ? "true" : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        // 640px is the smallest usable width: sidebar ~250 + min editor ~360 + chrome.
        // Below this, horizontal scroll is preferable to layout collapse.
        minWidth: 640,
        overflowX: "auto",
        overflowY: "hidden",
      }}
    >
      <MigrationBanner
        onResetConfirm={() => setDialogOpen(true)}
        status={status}
      />
      <McpUnavailableBanner status={status} />
      {/* Rename/tag-rewrite rollback error banner. Stacks below MigrationBanner. */}
      <RenameRewriteErrorBanner
        state={rewriteError}
        onDismiss={() => setRewriteError(null)}
      />
      <ResetAndRebuildDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConfirm={onConfirm}
      />
      {/* Command palette + cheat-sheet dialogs. Radix portal siblings to
          ResetAndRebuildDialog. paletteOpen/cheatSheetOpen are store slices set
          by the capture-phase keydown handlers. */}
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
      {/* Flush-on-close confirm dialog (TAB-13 / D-04). Shown only when an
          on-close flush save rejected; the user explicitly keeps or drops edits. */}
      <FlushConfirmDialog
        open={flushConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setFlushConfirm(null);
        }}
        filename={flushConfirm?.filename ?? ""}
        onKeepEditing={() => setFlushConfirm(null)}
        onCloseWithoutSaving={() => {
          if (flushConfirm !== null) {
            closeTab(flushConfirm.tabId);
            clearActiveOnEmptyTabs();
          }
          setFlushConfirm(null);
        }}
      />
      {/* Two-row grid. Column 1: ActivityRibbon (48px, spans both rows) — the
          new far-left activity bar (RIBBON-01..04). Row 1 col 3: TabStrip
          renders directly (its own right-hand cluster now hosts the sidebar
          toggles). Row 2 col 3: editor host. Sidebar + RightRail span both
          rows (gridRow "1/3"). StatusBar sits below the grid as a flex child.
          The fixed-track grid avoids position:sticky inside overflow:hidden. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `${zen ? 0 : 48}px ${!zen && notesSidebarVisible ? sidebarWidth : 0}px minmax(0, 1fr) ${!zen && backlinksRailExpanded ? backlinksRailWidth : 0}px`,
          gridTemplateRows: "auto minmax(0, 1fr)",
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {/* ActivityRibbon: spans both rows (gridRow 1/3) — column 1. Renders
            into a 0-width grid cell (clipped, not unmounted) when zen collapses
            the ribbon track (ZEN-01). */}
        <ActivityRibbon style={{ gridRow: "1 / 3", gridColumn: "1" }} />

        {/* TabStrip: row 1, column 3 — renders directly (D-04 dissolution).
            Always renders (incl. zero-tab state, which shows only the + new-tab
            button — TAB-14), except in zen (ZEN-01), where the tab bar hides. */}
        {!zen && (
          <TabStrip
            // Single-pane compatibility shim (Phase 25 Plan 06 retrofit;
            // App.tsx doesn't render <PaneTree> yet — that's Plan 07). Using
            // usePaneStore's OWN default activePaneId as this strip's leafId
            // trivially satisfies the new active-pane keyboard gate (there is
            // only ever one implicit pane until Plan 07 wires the real tree),
            // with zero behavior change for today's single-column app.
            leafId={usePaneStore.getState().activePaneId}
            style={{ gridRow: "1", gridColumn: "3", minWidth: 0 }}
            tabs={tabs}
            activeTabId={tabActiveTabId}
            deletedTabIds={deletedTabIds}
            titleForTab={titleForTab}
            onSelectTab={setActiveTab}
            onRequestClose={(id) => void flushAndClose(id).catch(() => {})}
            onCloseOthers={closeOthers}
            onCloseToRight={closeToRight}
            onOpenRight={openRight}
            onReorder={reorderTabs}
            onNewTab={newTab}
            onCycleTab={(dir) => useTabStore.getState().cycleTab(dir)}
          />
        )}

        {/* Sidebar: spans both rows (gridRow 1/3) — column 2.
            Selecting a note opens it as a tab (TAB-01/02). */}
        <Sidebar
          style={{ gridRow: "1 / 3", gridColumn: "2" }}
          onSelectNote={(id) => useTabStore.getState().openTab(id)}
        />

        {/* Editor host: row 2, column 3. One keep-alive EditorPane per open tab,
            all hidden except the active one (D-01). When no tabs are open, a single
            pane driven by the legacy activeNoteId renders the placeholder/empty state.
            During reindex, ReindexProgress OVERLAYS the cell and the panes are
            hidden via CSS — never unmounted. Unmounting would discard unsaved
            buffers and pending debounces (data loss); keeping the panes mounted
            lets EditorPane's reindexing save-block guard do its job. */}
        {reindexing && (
          <ReindexProgress
            style={{ gridRow: "2", gridColumn: "3" }}
            phase={reindexPhase}
            errorMessage={reindexError}
            onRetry={fireReindex}
            onClose={onCloseOverlay}
          />
        )}
        {tabs.length === 0 ? (
          <EditorPane
            style={{ gridRow: "2", gridColumn: "3" }}
            noteId={activeNoteId}
            hidden={reindexing}
            reindexing={reindexing}
            editorHandlersRef={fallbackHandlerRef}
            autosaveMs={config?.editor.autosaveMs ?? 2000}
          />
        ) : (
          tabs.map((tab) => (
            <EditorPane
              key={tab.id}
              style={{ gridRow: "2", gridColumn: "3" }}
              noteId={tab.noteId}
              hidden={reindexing || tab.id !== tabActiveTabId}
              isDeleted={deletedTabIds.has(tab.noteId)}
              reindexing={reindexing}
              editorHandlersRef={tabHandlerRefs.current[tab.id]}
              flushRef={tabFlushRefs.current[tab.id]}
              autosaveMs={config?.editor.autosaveMs ?? 2000}
            />
          ))
        )}

        {/* RightRail: spans both rows (gridRow 1/3) — column 4 */}
        <RightRail
          style={{ gridRow: "1 / 3", gridColumn: "4" }}
          activeNoteId={activeNoteId}
        />
      </div>
      {/* StatusBar: below the grid, full app width */}
      <StatusBar />
    </div>
    </>
  );
}

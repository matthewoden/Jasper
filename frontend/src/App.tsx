/**
 * App shell. ReindexProgress is presentational; AppInner owns the reindex
 * phase enum and drives the state machine. W-4 lock: no internal phase-state
 * in ReindexProgress.
 */

import {
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
import { FlushConfirmDialog } from "./components/FlushConfirmDialog";
import { KeyboardShortcutsDialog } from "./components/KeyboardShortcutsDialog";
import { McpUnavailableBanner } from "./components/McpUnavailableBanner";
import { MigrationBanner } from "./components/MigrationBanner";
import { RenameRewriteErrorBanner, type RewriteError } from "./components/RenameRewriteErrorBanner";
import { PaneTree } from "./components/PaneTree";
import { ReindexProgress } from "./components/ReindexProgress";
import { ResetAndRebuildDialog } from "./components/ResetAndRebuildDialog";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
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
import { useBookmarks } from "./lib/useBookmarks";
import type { Tab } from "./lib/useTabStore";
import { usePaneStore, pruneLayoutForMissingNotes } from "./lib/usePaneStore";
import * as searchHistory from "./lib/searchHistory";
import { _findLeaf, _updLeaf, newTabId } from "./lib/paneTree";
import { clampIndexToPinnedBoundary } from "./lib/tabOverflow";
import { getOrCreateController } from "./lib/noteBufferController";
import { useTreeMutations } from "./lib/useTreeMutations";
import {
  handleAppAltT,
  handleAppBookmarkToggle,
  handleAppCmdB,
  handleAppCmdDot,
  handleAppCmdI,
  handleAppCmdO,
  handleAppCmdP,
  handleAppCmdShiftD,
  handleAppCmdShiftF,
  handleAppCmdSlash,
  handleAppF2KeyDown,
  handleAppFocusNextPane,
  handleAppFocusPrevPane,
  handleAppPanelShortcuts,
  handleAppSidebarToggle,
  handleAppSplitDown,
  handleAppSplitRight,
  subscribePhase7,
} from "./lib/appShortcuts";
import {
  siblingNamesForCreate,
  useTreeCreateActions,
} from "./lib/useTreeCreateActions";
import { nextUntitledName } from "./lib/nextUntitledName";
import { useFileTree } from "./lib/useFileTree";
import { useConfig } from "./lib/useConfig";
import type { CommandActions } from "./lib/useCommandPalette";
import type { TreeNode } from "./lib/treeApi";
import {
  findNotePath as findActiveNotePath,
  parentDir,
} from "./lib/treeNoteLookup";

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

/**
 * Opens noteId as a tab in the given leaf (not necessarily the active pane) —
 * a leaf-targeted sibling of usePaneStore's own openInActivePane, needed by
 * per-leaf "open to the right" / "new tab" context actions (D-16/D-17 dedup
 * rules apply identically, just scoped to an explicit leafId).
 *
 * `afterTabId`, when given, inserts the new (always-unpinned) tab
 * immediately after that tab's position instead of appending at the end —
 * used by "New note to the right" (openRightInLeaf). Per D-16/Phase 30, the
 * insertion index is clamped to the pinned/unpinned boundary so a new
 * unpinned tab can never land inside a leaf's pinned group, even when
 * `afterTabId` itself is pinned (with more pinned tabs after it).
 */
export function openNoteInLeaf(leafId: string, noteId: string, afterTabId?: string): void {
  const { tree } = usePaneStore.getState();
  const leaf = _findLeaf(tree, leafId);
  if (!leaf) return;
  const existing = leaf.tabs.find((t) => t.noteId === noteId);
  if (existing) {
    usePaneStore.setState({ tree: _updLeaf(tree, leafId, { active: existing.id }) });
    return;
  }
  const tab: Tab = { id: newTabId(), noteId };
  let insertIndex = leaf.tabs.length; // default: append at the end
  if (afterTabId !== undefined) {
    const afterIdx = leaf.tabs.findIndex((t) => t.id === afterTabId);
    if (afterIdx !== -1) insertIndex = afterIdx + 1;
  }
  const pinnedCount = leaf.tabs.filter((t) => t.pinned).length;
  insertIndex = clampIndexToPinnedBoundary(insertIndex, pinnedCount, /* draggedIsPinned */ false);
  const tabs = [...leaf.tabs.slice(0, insertIndex), tab, ...leaf.tabs.slice(insertIndex)];
  usePaneStore.setState({
    tree: _updLeaf(tree, leafId, { tabs, active: tab.id }),
  });
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

  // --- Pane-tree state (Plan 07 — replaces the flat useTabStore model) ----
  const paneDeletedTabIds = usePaneStore((s) => s.deletedTabIds);

  // Flush-confirm dialog state: set when an on-close flush rejects (D-04).
  // leaf-scoped (a leaf's own tab, not a workspace-wide tab id — WS-03).
  const [flushConfirm, setFlushConfirm] = useState<{
    leafId: string;
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
        // Single dispatch to the per-note controller — no per-pane fan-out
        // (Pitfall 1 / WS-10): every pane showing this note shares one
        // controller instance, so one call reconciles all of them.
        getOrCreateController(p.id).onNoteUpdated(p);
      },
      onNoteDeleted: (p) => {
        getOrCreateController(p.id).onNoteDeleted(p);
        // Freeze the matching tab read-only for the rest of the session (D-10).
        usePaneStore.getState().markDeleted(p.id);
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
    window.addEventListener("keydown", handleAppCmdDot, true);
    window.addEventListener("keydown", handleAppCmdShiftD, true);
    window.addEventListener("keydown", handleAppCmdSlash, true);
    window.addEventListener("keydown", handleAppCmdB, true);
    window.addEventListener("keydown", handleAppCmdI, true);
    window.addEventListener("keydown", handleAppCmdShiftF, true);
    window.addEventListener("keydown", handleAppAltT, true);
    window.addEventListener("keydown", handleAppSplitRight, true);
    window.addEventListener("keydown", handleAppSplitDown, true);
    window.addEventListener("keydown", handleAppFocusNextPane, true);
    window.addEventListener("keydown", handleAppFocusPrevPane, true);
    window.addEventListener("keydown", handleAppSidebarToggle, true);
    window.addEventListener("keydown", handleAppBookmarkToggle, true);
    return () => {
      window.removeEventListener("keydown", handleAppCmdP, true);
      window.removeEventListener("keydown", handleAppCmdO, true);
      window.removeEventListener("keydown", handleAppCmdDot, true);
      window.removeEventListener("keydown", handleAppCmdShiftD, true);
      window.removeEventListener("keydown", handleAppCmdSlash, true);
      window.removeEventListener("keydown", handleAppCmdB, true);
      window.removeEventListener("keydown", handleAppCmdI, true);
      window.removeEventListener("keydown", handleAppCmdShiftF, true);
      window.removeEventListener("keydown", handleAppAltT, true);
      window.removeEventListener("keydown", handleAppSplitRight, true);
      window.removeEventListener("keydown", handleAppSplitDown, true);
      window.removeEventListener("keydown", handleAppFocusNextPane, true);
      window.removeEventListener("keydown", handleAppFocusPrevPane, true);
      window.removeEventListener("keydown", handleAppSidebarToggle, true);
      window.removeEventListener("keydown", handleAppBookmarkToggle, true);
    };
  }, []);

  const { openToday } = useDailyNote();
  const { toggleBookmark } = useBookmarks();
  useEffect(() => {
    return subscribePhase7((ev) => {
      if (ev === "openToday") void openToday();
      if (ev === "bookmarkCurrent") {
        const noteId = useTreeStore.getState().activeNoteId;
        if (noteId != null) void toggleBookmark(noteId);
      }
    });
  }, [openToday, toggleBookmark]);

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

  // --- Pane ↔ tree synchronization & persistence (Plan 07) ----------------

  // Keep useTreeStore.activeNoteId mirrored to the ACTIVE PANE's active tab
  // (D-07) so the tree highlight, breadcrumbs, RightRail, and backlinks rail
  // retarget automatically whenever the focused pane or its active tab
  // changes — no changes needed in those singleton components themselves.
  useEffect(() => {
    const syncActiveNote = () => {
      const { tree: paneTree, activePaneId } = usePaneStore.getState();
      const leaf = _findLeaf(paneTree, activePaneId);
      const activeTab = leaf?.tabs.find((t) => t.id === leaf.active) ?? null;
      useTreeStore.getState().setActiveNote(activeTab?.noteId ?? null);
    };
    syncActiveNote();
    return usePaneStore.subscribe(syncActiveNote);
  }, []);

  // Hydrate per-vault layout state once the vault is resolved (D-08/D-11). The
  // layout key is vault-scoped, so this can only run after BootGate hands us
  // the path. A fresh vault (no persisted layout) starts with a single empty
  // leaf — the legacy shouldPromoteActiveNote single-open promotion is
  // dropped entirely (pre-launch, D-18; deep-link routing is Plan 08's job).
  useEffect(() => {
    if (vaultPath === null) return;
    usePaneStore.getState().initForVault(vaultPath);
    searchHistory.initForVault(vaultPath);
  }, [vaultPath]);

  // After the first tree fetch, drop any persisted tab whose note no longer
  // exists in this vault (deleted-on-disk, or a stale UUID from another vault).
  // Deleted-session tabs are retained by pruneLayoutForMissingNotes itself (D-10).
  const prunedRef = useRef(false);
  useEffect(() => {
    if (prunedRef.current || tree === null) return;
    prunedRef.current = true;
    const notes = new Set<string>();
    collectNoteIds(tree.root, notes);
    pruneLayoutForMissingNotes(notes);
  }, [tree]);

  // titleForTab — live note title by UUID (TAB-12). Falls back to a stable
  // placeholder when the tree hasn't loaded the note yet.
  const titleForTab = useCallback(
    (noteId: string): string =>
      (tree && findNoteTitle(tree.root, noteId)) ?? "Untitled",
    [tree],
  );

  // flushAndCloseInLeaf — persist a closing tab's pending edits before removal
  // (TAB-13), scoped to the leaf it lives in. A deleted tab is frozen
  // read-only, so it has nothing to flush (D-10). On flush rejection, surface
  // the confirm dialog rather than dropping edits (D-04). Flushing goes
  // straight through the per-note controller (WS-10) — no per-pane ref lookup
  // needed, since exactly one controller instance exists per open noteId.
  const flushAndCloseInLeaf = useCallback(
    async (leafId: string, tabId: string): Promise<void> => {
      const leaf = _findLeaf(usePaneStore.getState().tree, leafId);
      const tab = leaf?.tabs.find((t) => t.id === tabId);
      if (tab === undefined) return;
      if (usePaneStore.getState().deletedTabIds.has(tab.noteId)) {
        usePaneStore.getState().closeTabInLeaf(leafId, tabId);
        return;
      }
      try {
        await getOrCreateController(tab.noteId).flush();
        usePaneStore.getState().closeTabInLeaf(leafId, tabId);
      } catch {
        const filename = titleForTab(tab.noteId);
        setFlushConfirm({ leafId, tabId, filename });
        // Re-throw so a sequential bulk loop pauses on the unresolved decision.
        throw new Error("flush failed");
      }
    },
    [titleForTab],
  );

  // Bulk closes run SEQUENTIALLY (Pitfall 7 — never Promise.all): each dirty tab
  // flushes and resolves before the next starts, so the confirm dialog (if any)
  // is handled one tab at a time. A rejected flush aborts the remaining loop.
  const closeOthersInLeaf = useCallback(
    (leafId: string, tabId: string): void => {
      void (async () => {
        const leaf = _findLeaf(usePaneStore.getState().tree, leafId);
        if (!leaf) return;
        const targets = leaf.tabs
          .filter((t) => t.id !== tabId)
          .filter((t) => !t.pinned)
          .map((t) => t.id);
        for (const id of targets) {
          try {
            await flushAndCloseInLeaf(leafId, id);
          } catch {
            return; // stop on the first unresolved flush (dialog now open)
          }
        }
      })();
    },
    [flushAndCloseInLeaf],
  );

  const closeToRightInLeaf = useCallback(
    (leafId: string, tabId: string): void => {
      void (async () => {
        const leaf = _findLeaf(usePaneStore.getState().tree, leafId);
        if (!leaf) return;
        const idx = leaf.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        const targets = leaf.tabs
          .slice(idx + 1)
          .filter((t) => !t.pinned)
          .map((t) => t.id);
        for (const id of targets) {
          try {
            await flushAndCloseInLeaf(leafId, id);
          } catch {
            return;
          }
        }
      })();
    },
    [flushAndCloseInLeaf],
  );

  // closeAllInLeaf — closes every non-pinned tab in the leaf (D-14: pinned
  // tabs are immune to every bulk-close path), mirroring closeOthersInLeaf's
  // sequential flush-then-close loop verbatim.
  const closeAllInLeaf = useCallback(
    (leafId: string): void => {
      void (async () => {
        const leaf = _findLeaf(usePaneStore.getState().tree, leafId);
        if (!leaf) return;
        const targets = leaf.tabs.filter((t) => !t.pinned).map((t) => t.id);
        for (const id of targets) {
          try {
            await flushAndCloseInLeaf(leafId, id);
          } catch {
            return;
          }
        }
      })();
    },
    [flushAndCloseInLeaf],
  );

  // onOpenRight — create a new note beside the context tab's note and open it
  // in the SAME leaf as the context tab (not necessarily the active pane).
  const openRightInLeaf = useCallback(
    (leafId: string, tabId: string): void => {
      const leaf = _findLeaf(usePaneStore.getState().tree, leafId);
      const tab = leaf?.tabs.find((t) => t.id === tabId);
      if (tab === undefined || tree === null) return;
      const notePath = findActiveNotePath(tree.root, tab.noteId);
      const parent = notePath !== null ? parentDir(notePath) : "";
      void (async () => {
        try {
          const created = await createNote(parent, uniqueUntitledTitle(parent));
          openNoteInLeaf(leafId, created.id, tabId);
        } catch {
          // Creation failures surface via the shared tree-mutation toast path;
          // nothing tab-specific to recover here.
        }
      })();
    },
    [tree, createNote, uniqueUntitledTitle],
  );

  // Shared create-then-open handler for both new-tab affordances (TAB-14):
  // the TabStrip + button and the Alt+T shortcut. Mirrors openRightInLeaf but
  // targets the GIVEN leaf's own active tab's note (parent dir), falling back
  // to the vault root "" when that leaf has no active tab (D-10 empty state).
  const newTabInLeaf = useCallback(
    (leafId: string): void => {
      const leaf = _findLeaf(usePaneStore.getState().tree, leafId);
      const activeTabRow = leaf?.tabs.find((t) => t.id === leaf.active) ?? null;
      const notePath =
        activeTabRow !== null && tree !== null
          ? findActiveNotePath(tree.root, activeTabRow.noteId)
          : null;
      const parent = notePath !== null ? parentDir(notePath) : "";
      void (async () => {
        try {
          const created = await createNote(parent, uniqueUntitledTitle(parent));
          openNoteInLeaf(leafId, created.id);
        } catch {
          // Creation failures surface via the shared tree-mutation toast path.
        }
      })();
    },
    [tree, createNote, uniqueUntitledTitle],
  );

  useEffect(() => {
    return subscribePhase7((ev) => {
      if (ev === "newTab") newTabInLeaf(usePaneStore.getState().activePaneId);
    });
  }, [newTabInLeaf]);

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

      onSplitRight: () => {
        setPaletteOpen(false);
        usePaneStore.getState().splitActivePane("row");
      },

      onSplitDown: () => {
        setPaletteOpen(false);
        usePaneStore.getState().splitActivePane("col");
      },

      onFocusNextPane: () => {
        setPaletteOpen(false);
        usePaneStore.getState().focusCyclePane(1);
      },

      onFocusPrevPane: () => {
        setPaletteOpen(false);
        usePaneStore.getState().focusCyclePane(-1);
      },

      // Palette invocation should NOT depend on the keyboard handler (Task 2,
      // D-13) — both this and handleAppSidebarToggle call the same store
      // action independently.
      onToggleSidebar: () => {
        setPaletteOpen(false);
        const s = useTreeStore.getState();
        s.setNotesSidebarVisible(!s.notesSidebarVisible);
      },

      // Palette invocation should NOT depend on the keyboard handler
      // (Task 2, mirrors onToggleSidebar) — both this and
      // handleAppBookmarkToggle (via the phase7 bus) call toggleBookmark
      // independently against the active pane's active note.
      onBookmarkCurrent:
        activeNoteId != null
          ? () => {
              setPaletteOpen(false);
              void toggleBookmark(activeNoteId);
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
      toggleBookmark,
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
            usePaneStore.getState().closeTabInLeaf(flushConfirm.leafId, flushConfirm.tabId);
          }
          setFlushConfirm(null);
        }}
      />
      {/* Two-row grid. Column 1: ActivityRibbon (48px, spans both rows) — the
          new far-left activity bar (RIBBON-01..04). Column 3: PaneTree spans
          BOTH rows (gridRow "1/3") — it owns its own internal per-leaf tab
          strip + editor body layout (Plan 06/07), collapsing the prior
          TabStrip(row1)/EditorPane(row2) split into PaneTree's own flex
          columns. Sidebar + RightRail also span both rows. StatusBar sits
          below the grid as a flex child. The fixed-track grid avoids
          position:sticky inside overflow:hidden. */}
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

        {/* Sidebar: spans both rows (gridRow 1/3) — column 2.
            Selecting a note opens it as a tab in the active pane (TAB-01/02,
            WS-08 openInActivePane). */}
        <Sidebar
          style={{ gridRow: "1 / 3", gridColumn: "2" }}
          onSelectNote={(id) => usePaneStore.getState().openInActivePane(id)}
        />

        {/* PaneTree: spans both rows (gridRow 1/3) — column 3. Recursively
            renders every leaf's own tab strip + keep-alive EditorPane stack
            (D-01 keep-alive preserved per leaf). During reindex,
            ReindexProgress OVERLAYS the same cell (row 2 only, matching the
            pre-Plan-07 editor-only overlay footprint) while every leaf's
            EditorPane stays mounted with reindexing=true — unmounting would
            discard unsaved buffers and pending debounces (data loss). */}
        {reindexing && (
          <ReindexProgress
            style={{ gridRow: "2", gridColumn: "3" }}
            phase={reindexPhase}
            errorMessage={reindexError}
            onRetry={fireReindex}
            onClose={onCloseOverlay}
          />
        )}
        <PaneTree
          style={{ gridRow: "1 / 3", gridColumn: "3" }}
          reindexing={reindexing}
          deletedTabIds={paneDeletedTabIds}
          titleForTab={titleForTab}
          onRequestClose={(leafId, tabId) =>
            void flushAndCloseInLeaf(leafId, tabId).catch(() => {})
          }
          onCloseOthers={closeOthersInLeaf}
          onCloseToRight={closeToRightInLeaf}
          onCloseAll={closeAllInLeaf}
          onOpenRight={openRightInLeaf}
          onTogglePin={(leafId, tabId) =>
            usePaneStore.getState().togglePinTab(leafId, tabId)
          }
          onNewTab={newTabInLeaf}
          hideTabStrip={zen}
          autosaveMs={config?.editor.autosaveMs ?? 2000}
        />

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

/**
 * EditorPane — thin view over the per-note noteBufferController (Plan 05).
 *
 * Content/save-state/debounce/coalesced-flush/WS-reconciliation logic lives
 * in `noteBufferController.ts` (Plan 04) — exactly one buffer per open note,
 * regardless of how many panes show it (WS-10). EditorPane bridges that
 * React-free controller into React via useSyncExternalStore, and keeps only
 * pane-local UI concerns: breadcrumb, inline title/H1 UI, outline
 * registration, the JSX shell, and browser-lifecycle keepalive plumbing.
 *
 * Reindexing/connectionStatus gating and refreshTree() (H1-rename tree
 * sync) are reintroduced HERE, at the call site, via controller.setSaveGate
 * and controller.subscribeRenamed — noteBufferController itself stays
 * React/Zustand-free (see its file header).
 *
 * When noteId is null, renders a locked placeholder with no API calls, no
 * controller. When noteId changes on an already-mounted instance (the
 * no-tabs fallback pane), the previous note's pending debounced edit is
 * discarded (never saved cross-note — WR-02), matching the old per-pane
 * "debounce armed for the previous note must never fire" guard.
 */

import {
  Fragment,
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  breadcrumbSegments,
  type BreadcrumbSegment,
} from "../lib/breadcrumbPrefix";
import { extractH1FromContent } from "../lib/h1Extract";
import { getNote, updateNote } from "../lib/notesApi";
import { generateOrLoadSessionId } from "../lib/sessionId";
import { initialSaveState } from "../lib/saveStateMachine";
import {
  getOrCreateController,
  releaseController,
  type NoteBufferController,
} from "../lib/noteBufferController";
import { getPrimaryView } from "../lib/sharedDocRegistry";
import { type Tree, type TreeNode } from "../lib/treeApi";
import { useFileTree } from "../lib/useFileTree";
import { useTreeStore } from "../lib/useTreeStore";
import { useOutlineStore } from "../lib/useOutlineStore";
import { countWords, formatWordCount } from "../lib/wordCount";
import type { HeadingInfo } from "../editor/outlineExtract";
import type { components } from "../api/schema";
import type { SearchQuery } from "@codemirror/search";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";
import { expandAndScrollToFolder } from "./fileTree.utils";
import { TitleElement } from "./TitleElement";

import { FilePreviewView } from "./FilePreviewView";

type LoadStatus = "loading" | "loaded" | "error";


type WSNoteUpdatedPayload = components["schemas"]["WSNoteUpdatedPayload"];
type WSNoteDeletedPayload = components["schemas"]["WSNoteDeletedPayload"];

/** Handler ref written by EditorPane on mount so App can dispatch WS events into this editor. */
export interface EditorPaneHandlers {
  onNoteUpdated: (p: WSNoteUpdatedPayload) => void;
  onNoteDeleted: (p: WSNoteDeletedPayload) => void;
  /**
   * Search commands (P26, WS-09/D-01) — delegate straight to the internal
   * MarkdownEditor ref, so the Find bar reaches THIS pane's own EditorView
   * via LeafPane's handlerRefs map.
   */
  setSearchQuery: (query: SearchQuery) => void;
  findNext: () => boolean;
  findPrevious: () => boolean;
  replaceNext: () => boolean;
  replaceAll: () => boolean;
  matchInfo: () => { current: number; total: number };
  clearSearch: () => void;
  /** Returns focus to this pane's editor (P26, D-02 — Esc closes the Find bar and refocuses). */
  focus: () => void;
}


export const AUTOSAVE_DEBOUNCE_MS = 2000;
export const SAVED_STICKY_MS = 2000;

const LOAD_ERROR_COPY =
  "Could not load note. Check that the server is running, then refresh the page.";


const NULL_NOTE_PLACEHOLDER_COPY = "Select a note to start editing.";

interface EditorPaneProps {
  noteId: string | null;
  reindexing?: boolean;
  editorHandlersRef?: MutableRefObject<EditorPaneHandlers | null>;
  /** Optional style for grid placement; App.tsx passes gridRow/gridColumn here. */
  style?: React.CSSProperties;
  /** Autosave debounce interval in ms. Read through a ref at debounce-arm time; follows prop updates (config loads async). */
  autosaveMs?: number;
  /** display:none when true; CM6 stays mounted so cursor/scroll/undo survive (keep-alive, D-01). */
  hidden?: boolean;
  /**
   * True when this pane's leaf is the active pane (WS-07). Gates programmatic
   * autofocus: only the ACTIVE pane's editor steals DOM focus when a note
   * finishes loading. Without this gate, EVERY visible pane's editor focuses
   * on mount, so on a reload with a restored two-pane layout the last note to
   * load would win DOM focus and (via LeafPane's onFocusCapture → setActivePane)
   * override the restored active pane — making WS-08's active-pane restore
   * non-deterministic (D-12). Defaults true so single-pane / non-LeafPane
   * callers keep today's autofocus behavior.
   */
  paneActive?: boolean;
  /** Read-only + suppress the in-pane deletion banner; the tab pill owns the "(deleted)" indicator (D-10). */
  isDeleted?: boolean;
  /** tab-close awaits flush() to persist pending edits before the tab is removed (TAB-13). */
  flushRef?: MutableRefObject<{ flush: () => Promise<void> } | null>;
  /** Cmd+F handler (P26, WS-09/D-02) — opens this pane's find-only bar. */
  onOpenFind?: () => void;
  /** Cmd+Opt+F handler (P26, WS-09/D-02) — opens this pane's find+replace bar. */
  onOpenFindReplace?: () => void;
}


function findNotePathInTree(tree: Tree | null, noteId: string): string | null {
  if (tree === null) return null;
  const visit = (node: TreeNode): string | null => {
    switch (node.kind) {
      case "note":
        return node.id === noteId ? node.path : null;
      case "folder":
        if (node.children) {
          for (const child of node.children) {
            const hit = visit(child);
            if (hit !== null) return hit;
          }
        }
        return null;
      case "file":
        return null;
      default: {
        const _exhaust: never = node;
        return _exhaust;
      }
    }
  };
  for (const node of tree.root) {
    const hit = visit(node);
    if (hit !== null) return hit;
  }
  return null;
}

export function EditorPane({ noteId, reindexing = false, editorHandlersRef, style, autosaveMs, hidden = false, paneActive = true, isDeleted = false, flushRef, onOpenFind, onOpenFindReplace }: EditorPaneProps) {
  const autosaveMsRef = useRef(autosaveMs ?? AUTOSAVE_DEBOUNCE_MS);
  // Follow prop updates: panes mount before the async /config fetch resolves,
  // so a mount-only capture would pin them to the default interval forever.
  useEffect(() => {
    autosaveMsRef.current = autosaveMs ?? AUTOSAVE_DEBOUNCE_MS;
  }, [autosaveMs]);

  // Per-note controller (Plan 04): a stable singleton per noteId, shared by
  // every pane showing that note. Safe to derive during render — the
  // underlying map is idempotent, so a duplicate render (StrictMode) never
  // creates a second instance.
  const controller: NoteBufferController | null =
    noteId !== null
      ? getOrCreateController(noteId, autosaveMsRef.current)
      : null;

  const subscribeController = useCallback(
    (onStoreChange: () => void) => {
      if (!controller) return () => {};
      return controller.subscribe(onStoreChange);
    },
    [controller],
  );

  const content = useSyncExternalStore(
    subscribeController,
    () => controller?.getContent() ?? "",
  );
  const saveState = useSyncExternalStore(
    subscribeController,
    () => controller?.getSaveState() ?? initialSaveState,
  );
  const conflictBanner = useSyncExternalStore(
    subscribeController,
    () => controller?.getConflict() ?? null,
  );
  const deletedBanner = useSyncExternalStore(
    subscribeController,
    () => controller?.getDeleted() ?? null,
  );
  const h1RenameError = useSyncExternalStore(
    subscribeController,
    () => controller?.getH1RenameError() ?? null,
  );
  // notePath sourced from THIS pane's own controller (seeded by its getNote()
  // load, kept fresh by the tree-sync effect below) rather than from the
  // per-pane useFileTree() fetch. This makes the breadcrumb + word-count
  // metadata bar appear atomically with the note content — independent of the
  // async tree fetch and of which pane is active — so an inactive or
  // freshly-split pane always shows its OWN metadata bar (Phase 25 UAT-4).
  const controllerNotePath = useSyncExternalStore(
    subscribeController,
    () => controller?.getNotePath() ?? "",
  );

  // Hook must run unconditionally (rules-of-hooks) — placed before the
  // component's later conditional early returns (activeFilePath / noteId null).
  const wordCount = useMemo(() => countWords(content), [content]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const { tree, refresh: refreshTree } = useFileTree();

  const connectionStatus = useTreeStore((s) => s.connectionStatus);

  const activeFilePath = useTreeStore((s) => s.activeFilePath);

  const toggleExpanded = useTreeStore((s) => s.toggleExpanded);
  const setPulseTarget = useTreeStore((s) => s.setPulseTarget);
  const setNotesSidebarVisible = useTreeStore((s) => s.setNotesSidebarVisible);
  const activeNoteId = useTreeStore((s) => s.activeNoteId);
  const zen = useTreeStore((s) => s.zen);

  const handleBreadcrumbClick = useCallback((seg: BreadcrumbSegment) => {
    if (seg.kind === "folder") {
      expandAndScrollToFolder(seg.folderPath);
      setPulseTarget({ kind: "folder", target: seg.folderPath });
    } else {
      // Note segment: expand ancestors, pulse the note row in the tree
      const parts = seg.folderPath.split("/").filter(Boolean).slice(0, -1);
      parts.forEach((_, i) => {
        const anc = parts.slice(0, i + 1).join("/");
        if (!useTreeStore.getState().expanded.has(anc)) toggleExpanded(anc);
      });
      setNotesSidebarVisible(true);
      if (activeNoteId) {
        setPulseTarget({ kind: "note", target: activeNoteId });
      }
    }
  }, [toggleExpanded, setPulseTarget, setNotesSidebarVisible, activeNoteId]);

  const editorRef = useRef<MarkdownEditorRef>(null);
  // Mirrors `content` for synchronous-closure call sites (keepalive/blur/
  // reconnect handlers below) that cannot re-subscribe on every keystroke.
  const latestContentRef = useRef("");
  useEffect(() => {
    latestContentRef.current = content;
  }, [content]);

  // Outline (RSIDE-01): cache of the last-computed heading list for THIS pane,
  // updated on every onHeadingsChange call regardless of the active-tab guard
  // below. Needed because the "become active" transition (a brand-new tab's
  // mount-time push races the App-level activeTabId->activeNoteId mirror
  // effect, which runs one commit later — see the become-active effect near
  // handleEditorHeadingsChange) must be able to flush a cached, already-computed
  // heading list into the shared store without waiting on another doc change.
  const latestHeadingsRef = useRef<HeadingInfo[]>([]);
  // Mirrors the controller's internal userHasEdited flag for synchronous
  // call sites (keepalive/blur/reconnect/note-switch decisions) that read it
  // outside a render.
  const userHasEdited = useRef(false);
  const noteIdRef = useRef<string | null>(noteId);
  useEffect(() => {
    noteIdRef.current = noteId;
  }, [noteId]);

  const connectionStatusRef = useRef(connectionStatus);
  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);

  // Stable-closure handle for the visibilitychange handler below (empty deps
  // — must read whichever controller is CURRENT at hide-time, not the one
  // captured when the effect first mounted).
  const controllerRef = useRef<NoteBufferController | null>(controller);
  useEffect(() => {
    controllerRef.current = controller;
  }, [controller]);

  // Only the VISIBLE pane owns the global save indicator: hidden keep-alive
  // panes save in the background (blur, reconnect-flush) and would otherwise
  // drive the status bar last-writer-wins for a note the user isn't viewing.
  useEffect(() => {
    if (hidden) return;
    useTreeStore.getState().setSaveState(saveState);
  }, [saveState, hidden]);

  const keepaliveSentRef = useRef(false);

  const reindexingRef = useRef(reindexing);
  useEffect(() => {
    reindexingRef.current = reindexing;
  }, [reindexing]);

  // Reindex/connectionStatus gating (reintroduced at the call site — the
  // controller stays React-free): checked at the START of every save
  // attempt the controller makes (debounced, flush()-triggered, or
  // reconnect-triggered) via ONE choke point inside the controller's own
  // internal save method. The gate closure reads the CURRENT ref values, so
  // it never goes stale.
  useEffect(() => {
    if (!controller) return;
    // WR-03 fix (25-REVIEW.md): setSaveGate is now multi-owner — it returns
    // an unregister function scoped to THIS pane's gate only. Returning it
    // directly as the effect cleanup means one pane's unmount can no longer
    // null out a gate that a surviving sibling pane on the same note still
    // relies on.
    return controller.setSaveGate(
      () => !reindexingRef.current && connectionStatusRef.current === "connected",
    );
  }, [controller]);

  // WR-04: autosaveMs can arrive after mount (async /config fetch) — push it
  // into the controller explicitly since getOrCreateController only honors
  // its autosaveMs argument on first construction.
  useEffect(() => {
    if (!controller) return;
    controller.setAutosaveMs(autosaveMs ?? AUTOSAVE_DEBOUNCE_MS);
  }, [controller, autosaveMs]);

  // A successful H1-driven rename moves the note on disk. WS `note:moved`
  // broadcasts exclude the originating session (SYNC-03), so THIS pane
  // (which caused the rename) would never otherwise see its own tree entry
  // update — refresh directly.
  useEffect(() => {
    if (!controller) return;
    return controller.subscribeRenamed(() => {
      void refreshTree();
    });
  }, [controller, refreshTree]);

  // MarkdownEditor is uncontrolled — the CM6 view only ever shows a NEW
  // document via the ref's applyServerUpdate call, never by reacting to a
  // content prop change. A silent WS onNoteUpdated adopt happens entirely
  // inside the controller, so push its result into the ref here.
  useEffect(() => {
    if (!controller) return;
    return controller.subscribeContentReplaced((newContent) => {
      editorRef.current?.applyServerUpdate(newContent);
    });
  }, [controller]);

  // CR-01/CR-02: keep the controller's rename-comparator path in sync with
  // the LIVE tree — the note may have moved (another session, a WS
  // folder/note move) since this pane's initial GET seeded hydrate()'s path,
  // and the H1-rename detector must compose the new path against the note's
  // ACTUAL current parent directory, not a stale load-time snapshot.
  useEffect(() => {
    if (!controller || noteId === null) return;
    const livePath = findNotePathInTree(tree, noteId);
    if (livePath !== null) {
      controller.setNotePath(livePath);
    }
  }, [controller, tree, noteId]);

  // Release the controller ONLY on true unmount (tab/pane closed) — deps
  // intentionally empty so this cleanup does NOT also fire on a mere
  // noteId-prop switch (the no-tabs fallback pane keeps the SAME EditorPane
  // instance alive across notes; releasing here would flush/save the
  // abandoned note's buffer via releaseController's own flush-before-release
  // step, contradicting WR-02's "no cross-note PUT" — discardPendingEdit
  // below handles that transition instead). noteIdRef.current at cleanup
  // time reflects whichever note this pane was LAST showing. Never fires on
  // a mere hide (D-01 keep-alive): hidden panes stay mounted, nothing here
  // re-runs. getPrimaryView guards against releasing a controller another
  // view still depends on.
  useEffect(() => {
    return () => {
      const id = noteIdRef.current;
      if (id === null) return;
      if (getPrimaryView(id) === null) {
        void releaseController(id);
      }
    };
  }, []);

  const prevNoteIdRef = useRef<string | null>(noteId);

  useEffect(() => {
    // A debounce armed for the previous note must never fire against the new
    // note — the abandoned controller's content may still hold an unsaved
    // edit and the save would write it under the wrong note (WR-02:
    // cross-note corruption guard).
    {
      const prevId = prevNoteIdRef.current;
      if (prevId !== null && prevId !== noteId) {
        getOrCreateController(prevId, autosaveMsRef.current).discardPendingEdit();
        if (userHasEdited.current) {
          useTreeStore.getState().clearLiveLabel(prevId);
        }
      }
      prevNoteIdRef.current = noteId;
    }
    if (noteId === null) {
      setLoadStatus("loaded");
      userHasEdited.current = false;
      return;
    }
    const abortCtrl = new AbortController();
    setLoadStatus("loading");
    userHasEdited.current = false;
    (async () => {
      const { data, error } = await getNote(noteId, {
        signal: abortCtrl.signal,
      });
      if (abortCtrl.signal.aborted) return;
      if (error || !data) {
        setLoadStatus("error");
        return;
      }
      if (!userHasEdited.current) {
        getOrCreateController(noteId, autosaveMsRef.current).hydrate(
          data.content,
          data.path,
        );
        editorRef.current?.applyServerUpdate(data.content);
      }
      setLoadStatus("loaded");
    })();
    return () => {
      abortCtrl.abort();
    };
  }, [noteId]);

  useEffect(() => {
    if (!hidden && paneActive && loadStatus === "loaded" && noteId !== null) {
      editorRef.current?.focus();
    }
  }, [hidden, paneActive, loadStatus, noteId]);

  const prevConnectionStatusRef = useRef(connectionStatus);

  useEffect(() => {
    const prev = prevConnectionStatusRef.current;
    if (prev !== connectionStatus && prev !== "connected" && connectionStatus === "connected") {
      // Reconnect-flush (WR-02): a debounced save blocked by the closed gate
      // while disconnected never fired; retry once the gate re-opens.
      // flush() itself no-ops when there is nothing pending.
      if (controller) {
        void controller.flush().catch(() => {
          // Best-effort retry — failures already surface via saveState.
        });
      }
    }
    prevConnectionStatusRef.current = connectionStatus;
  }, [connectionStatus, controller]);

  const handleEditorChange = useCallback(
    (next: string) => {
      userHasEdited.current = true;
      latestContentRef.current = next;
      controller?.handleEditorChange(next);
    },
    [controller],
  );

  const handleEditorH1Change = useCallback(
    (h1: string | null) => {
      const id = noteIdRef.current;
      if (id === null) return;
      if (h1 === null || h1.trim() === "") {
        useTreeStore.getState().clearLiveLabel(id);
      } else {
        useTreeStore.getState().setLiveLabel(id, h1.trim());
      }
    },
    [],
  );

  // Outline (RSIDE-01): only the pane whose noteId IS the active tab writes
  // into the shared outline store — keep-alive background panes must not
  // clobber the outline with their (invisible) content. latestHeadingsRef is
  // always updated so the become-active effect below can flush a cached
  // heading list without depending on another doc-changed event firing.
  const handleEditorHeadingsChange = useCallback(
    (headings: HeadingInfo[]) => {
      latestHeadingsRef.current = headings;
      if (noteIdRef.current === null) return;
      if (noteIdRef.current !== useTreeStore.getState().activeNoteId) return;
      useOutlineStore.getState().setOutlineHeadings(headings);
    },
    [],
  );

  // Register this pane's scrollToHeading into the shared outline store, and
  // flush its cached heading list, whenever it becomes (or is) the active
  // tab, so OutlinePanel always drives the currently-active editor. Cleared
  // on unmount / deactivation.
  //
  // The heading-list flush closes a real race (found live via phase20-uat.spec.ts,
  // never caught by mocked component tests): MarkdownEditor's mount-time
  // "fire once" push in handleEditorHeadingsChange runs as a CHILD effect
  // within the SAME commit as the tab-open render, but the App-level
  // `activeTabId -> useTreeStore.activeNoteId` mirror is a PARENT effect that
  // commits its state update one render later. So on the very first open of a
  // brand-new tab, the guard above sees activeNoteId as still stale (or null)
  // and silently drops the initial heading push — Outline would then show
  // "No headings" until the user made a live edit. Flushing latestHeadingsRef here
  // (which the mount-time push always populates, guard notwithstanding) once
  // this effect's own [hidden, noteId, activeNoteId] deps confirm the mirror
  // settled closes that gap without waiting on a doc change.
  useEffect(() => {
    if (hidden || noteId === null || noteId !== activeNoteId) return;
    useOutlineStore.getState().setOutlineHeadings(latestHeadingsRef.current);
    const scrollHandler = (from: number) => {
      editorRef.current?.scrollToHeading(from);
    };
    useOutlineStore.getState().setScrollToHeading(scrollHandler);
    return () => {
      // Only clear if we're still the registered handler owner — a newly
      // active pane's effect may have already overwritten the store by the
      // time a stale cleanup runs; clearing then would clobber the new
      // pane's registration. When we ARE still the owner (e.g. the last tab
      // just closed), also reset the headings so the Outline panel doesn't
      // keep rendering a note that is no longer open.
      if (useOutlineStore.getState().scrollToHeading === scrollHandler) {
        useOutlineStore.getState().setScrollToHeading(null);
        useOutlineStore.getState().setOutlineHeadings([]);
      }
    };
  }, [hidden, noteId, activeNoteId]);

  const handleSaveRequested = useCallback(() => {
    if (!controller) return;
    void controller.flush().catch(() => {
      // Best-effort — Cmd+S / checkbox-toggle failures already surface via
      // saveState; this call site doesn't otherwise handle the rejection.
    });
  }, [controller]);

  const handleEditorBlur = useCallback(() => {
    if (!userHasEdited.current) return;
    if (!controller) return;
    void controller.flush().catch(() => {
      // Best-effort — failures already surface via saveState.
    });
  }, [controller]);

  // flush() — cancel the pending debounce and save synchronously, awaitable by the
  // tab-close flow so a closing tab never drops mid-debounce edits (TAB-13, D-04).
  // Rejects when the save fails so the caller can surface a confirm dialog.
  const flush = useCallback(async () => {
    if (!controller) return;
    await controller.flush();
  }, [controller]);

  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = { flush };
    return () => {
      flushRef.current = null;
    };
  }, [flushRef, flush]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") {
        keepaliveSentRef.current = false;
        return;
      }
      // A debounce armed for this note must never fire once the keepalive
      // beacon below takes over persistence duty for the hidden tab.
      // Cancelled unconditionally, before any of the later guards, matching
      // the pre-Plan-04 EditorPane.onVisibilityChange ordering exactly.
      controllerRef.current?.discardPendingEdit();
      const id = noteIdRef.current;
      if (id === null) return;
      if (connectionStatusRef.current !== "connected") return;
      if (keepaliveSentRef.current) return;
      if (!userHasEdited.current) return;
      if (useTreeStore.getState().vaultSwitching.active) return;
      keepaliveSentRef.current = true;
      void fetch(`/api/v1/notes/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Session-ID": generateOrLoadSessionId(),
        },
        body: JSON.stringify({ content: latestContentRef.current }),
        keepalive: true,
      });
    };
    const onBeforeUnload = () => {
      if (keepaliveSentRef.current) return;
      const id = noteIdRef.current;
      if (id === null) return;
      if (connectionStatusRef.current !== "connected") return;
      if (!userHasEdited.current) return;
      if (useTreeStore.getState().vaultSwitching.active) return;
      keepaliveSentRef.current = true;
      void fetch(`/api/v1/notes/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Session-ID": generateOrLoadSessionId(),
        },
        body: JSON.stringify({ content: latestContentRef.current }),
        keepalive: true,
      });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
    // refs only — the controller is read through noteIdRef-derived lookups
    // at call time, so the dep array is intentionally empty.
  }, []);


  // Delegate straight to the controller — fired once per noteId regardless
  // of how many panes have this note open (Pitfall 1: no per-pane fan-out).
  // Plan 07 will have App call the controller directly; this indirection
  // stays for now so editorHandlersRef's existing wiring is untouched.
  const onNoteUpdated = useCallback(
    (p: WSNoteUpdatedPayload) => {
      controller?.onNoteUpdated(p);
    },
    [controller],
  );

  const onNoteDeleted = useCallback(
    (p: WSNoteDeletedPayload) => {
      controller?.onNoteDeleted(p);
    },
    [controller],
  );

  // Search commands (P26, WS-09/D-01) — thin delegates to the internal
  // MarkdownEditor ref, exposed through editorHandlersRef so LeafPane's Find
  // bar can reach THIS pane's own EditorView.
  const setSearchQuery = useCallback((query: SearchQuery) => {
    editorRef.current?.setSearchQuery(query);
  }, []);
  const findNext = useCallback(() => editorRef.current?.findNext() ?? false, []);
  const findPrevious = useCallback(() => editorRef.current?.findPrevious() ?? false, []);
  const replaceNext = useCallback(() => editorRef.current?.replaceNext() ?? false, []);
  const replaceAll = useCallback(() => editorRef.current?.replaceAll() ?? false, []);
  const matchInfo = useCallback(
    () => editorRef.current?.matchInfo() ?? { current: 0, total: 0 },
    [],
  );
  const clearSearch = useCallback(() => editorRef.current?.clearSearch(), []);
  const focusEditor = useCallback(() => editorRef.current?.focus(), []);

  useEffect(() => {
    if (editorHandlersRef) {
      editorHandlersRef.current = {
        onNoteUpdated,
        onNoteDeleted,
        setSearchQuery,
        findNext,
        findPrevious,
        replaceNext,
        replaceAll,
        matchInfo,
        clearSearch,
        focus: focusEditor,
      };
    }
    return () => {
      if (editorHandlersRef) {
        editorHandlersRef.current = null;
      }
    };
  }, [
    editorHandlersRef,
    onNoteUpdated,
    onNoteDeleted,
    setSearchQuery,
    findNext,
    findPrevious,
    replaceNext,
    replaceAll,
    matchInfo,
    clearSearch,
    focusEditor,
  ]);

  // WR-05 fix (25-REVIEW.md): activeFilePath is a single GLOBAL value in
  // useTreeStore, so without the paneActive gate every mounted EditorPane
  // (every pane in a split layout) would render the SAME file preview,
  // hijacking panes that should keep showing their own note. Scoping this
  // to only the currently-active pane (paneActive, already threaded down
  // from LeafPane's isActive) means previewing a non-note file replaces
  // just the active pane's content — sibling panes keep their own note.
  if (activeFilePath !== null && paneActive) {
    return (
      <section
        className="flex flex-col h-full bg-bg"
        style={{
          display: hidden ? "none" : undefined,
          minHeight: 0,
          overflow: "hidden",
          ...style,
        }}
        data-testid="editor-pane-file-preview"
      >
        <FilePreviewView path={activeFilePath} />
      </section>
    );
  }

  if (noteId === null) {
    return (
      <section
        className="flex flex-col h-full bg-bg"
        data-testid="editor-pane-placeholder"
        style={{ display: hidden ? "none" : undefined, ...style }}
      >
        <div
          className="flex items-center justify-center"
          style={{
            flex: 1,
            width: "100%",
            maxWidth: zen ? 700 : 760,
            margin: "0 auto",
            padding: zen ? "64px 32px" : "44px 56px 200px",
            boxSizing: "border-box",
          }}
        >
          <p
            style={{
              fontSize: 14,
              fontWeight: 400,
              color: "var(--color-muted)",
            }}
          >
            {NULL_NOTE_PLACEHOLDER_COPY}
          </p>
        </div>
      </section>
    );
  }

  // Per-segment interactive breadcrumb above the note body. Clicking a folder
  // segment reveals it in the tree; clicking the title segment pulses the note
  // row. Sourced from the pane's own controller (getNotePath, above) so it is
  // present as soon as the note loads — never gated on the async per-pane tree
  // fetch or on which pane is active.
  const notePath = controllerNotePath !== "" ? controllerNotePath : null;

  // Inline title (D-01/D-02): the H1 IS the title. When a note has no H1
  // (API/MCP-created, imported, or not-yet-headed), fall back to the note's
  // filename so a named file never reads as "Untitled" — matches Obsidian,
  // where the inline title is the filename. Only a genuinely nameless note
  // (no H1, no path) shows the "Untitled" placeholder.
  const titleH1 = extractH1FromContent(content);
  const titleFallback =
    titleH1 ?? (notePath ? (breadcrumbSegments(notePath).at(-1)?.label ?? null) : null);

  return (
    <section
      className="flex flex-col h-full bg-bg"
      data-testid="editor-pane"
      style={{
        display: hidden ? "none" : "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
        position: "relative",
        ...style,
      }}
    >
      {loadStatus === "error" && (
        <div className="px-4 text-destructive" role="alert">
          {LOAD_ERROR_COPY}
        </div>
      )}
      {h1RenameError && (
        <div
          className="px-4"
          role="alert"
          style={{
            color: "var(--color-destructive)",
            fontSize: 12,
          }}
        >
          {h1RenameError}
        </div>
      )}
      {/* conflict banner — stacks after h1RenameError, before textarea */}
      {conflictBanner?.visible && (
        <div className="px-4" role="alert" data-testid="conflict-banner">
          <span>
            This note was updated in another session. Save anyway, or discard your changes?
          </span>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                const id = noteIdRef.current;
                if (id === null || !controller) return;
                const result = await updateNote(
                  id,
                  latestContentRef.current,
                  conflictBanner.currentUpdatedAt,
                );
                if (result.error) {
                  const staleErr = result.error as {
                    code?: string;
                    message?: string;
                    current_updated_at?: string;
                  };
                  if (
                    staleErr.code === "stale_write" &&
                    staleErr.current_updated_at
                  ) {
                    controller.setH1RenameError(null);
                    controller.setConflict({
                      visible: true,
                      currentUpdatedAt: staleErr.current_updated_at,
                    });
                    return;
                  }
                  const msg = staleErr.message ?? "save failed";
                  let recoveryHint =
                    "Save failed — try Discard or close the banner and retry on next sync.";
                  try {
                    const fresh = await getNote(id);
                    if (fresh.data) {
                      controller.setConflict({
                        visible: true,
                        currentUpdatedAt: fresh.data.updated_at,
                      });
                      recoveryHint =
                        "Save failed — the latest version was loaded; click Save anyway again to retry, or Discard to drop your edits.";
                    }
                  } catch {
                    // Network down for the recovery fetch too — keep the
                    // banner with its original comparator; the message
                    // tells the user to wait for next sync.
                  }
                  controller.setH1RenameError(`Couldn't save: ${msg}. ${recoveryHint}`);
                  controller.reportSaveFailed(msg);
                  return;
                }
                controller.setH1RenameError(null);
                controller.setConflict(null);
                controller.discardPendingEdit();
                userHasEdited.current = false;
              })();
            }}
          >
            Save anyway
          </button>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                const id = noteIdRef.current;
                if (!id || !controller) return;
                const { data, error } = await getNote(id);
                if (id !== noteIdRef.current) return;
                if (error || !data) {
                  const msg =
                    (error as { message?: string } | undefined)?.message ??
                    "couldn't load latest version";
                  controller.setH1RenameError(`Discard failed: ${msg}. Try again.`);
                  return;
                }
                controller.hydrate(data.content, data.path);
                userHasEdited.current = false;
                editorRef.current?.applyServerUpdate(data.content);
              })();
            }}
          >
            Discard
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => controller?.setConflict(null)}
          >
            ×
          </button>
        </div>
      )}
      {/* deletion banner — informational only; content is never cleared.
          Suppressed when isDeleted: the tab pill's "(deleted)" indicator is the
          single source of that signal under the tab model (D-10). */}
      {!isDeleted && deletedBanner?.visible && (
        <div className="px-4" role="alert" data-testid="deleted-banner">
          <span>This note was deleted in another session</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => controller?.setDeleted(null)}
          >
            ×
          </button>
        </div>
      )}
      {!zen && notePath && breadcrumbSegments(notePath).length > 0 && (
        <nav
          data-testid="note-breadcrumb"
          aria-label="Note path"
          style={{
            height: 26,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "0 var(--editor-content-x)",
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              maxWidth: "70%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 12,
            }}
          >
            {breadcrumbSegments(notePath).map((seg, i, arr) => (
              <Fragment key={seg.folderPath}>
                <button
                  type="button"
                  data-testid="breadcrumb-segment"
                  aria-label={`Reveal ${seg.label} in Files`}
                  onClick={() => handleBreadcrumbClick(seg)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "color-mix(in srgb, var(--color-fg) 75%, transparent)",
                    fontSize: 12,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    padding: "0 2px",
                    borderRadius: 2,
                    lineHeight: "inherit",
                  }}
                >
                  {seg.label}
                </button>
                {i < arr.length - 1 && (
                  <span
                    data-testid="breadcrumb-separator"
                    aria-hidden="true"
                    style={{
                      color: "var(--color-muted)",
                      margin: "0 4px",
                      fontSize: 12,
                      lineHeight: "inherit",
                      userSelect: "none",
                    }}
                  >
                    /
                  </span>
                )}
              </Fragment>
            ))}
          </div>
          <span
            data-testid="word-count"
            style={{
              flexShrink: 0,
              fontSize: 12,
              color: "var(--color-muted)",
            }}
          >
            {formatWordCount(wordCount)}
          </span>
        </nav>
      )}
      {/* Title element (READ-01/D-01/D-02/D-04): inside the same 760px column,
          sharing its 56px horizontal padding (NOT --editor-content-x, which
          is the breadcrumb's pane-wide chrome padding, D-16). Reads/writes
          through the EXISTING onH1Change/rewriteH1 binding via the
          MarkdownEditor ref's setH1 — no second rename pathway. */}
      <div
        className="editor-title-wrapper"
        style={{
          width: "100%",
          maxWidth: zen ? 700 : 760,
          margin: "0 auto",
          // paddingBottom keeps the title's 2px focus ring clear of the editor
          // shell below (which starts flush at the wrapper's edge and would
          // otherwise paint over the ring's bottom).
          padding: zen ? "0 32px 6px" : "0 56px 6px",
          boxSizing: "border-box",
        }}
      >
        <TitleElement
          title={titleFallback}
          onTitleChange={(next) => editorRef.current?.setH1(next)}
          onFocusHandoff={() => editorRef.current?.focus()}
        />
      </div>
      {/* MarkdownEditor is uncontrolled — initialDoc captured once on mount;
          updates flow through the ref API. Click-anywhere-to-type: clicks outside
          .cm-content call focusEnd() to move caret to end-of-doc.
          The shell carries NO horizontal padding: the reading column is the
          self-centering 760px .cm-content (margin:0 auto, 21-01/D-14). Adding
          --editor-content-x here (pane-wide breadcrumb chrome, D-16) would shift
          that centered column's axis and push the body out of alignment with the
          inline title, which centers against the full pane. */}
      <div
        className="cm-host-shell"
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest(".cm-content")) return;
          editorRef.current?.focusEnd();
        }}
        data-testid="cm-host-shell"
      >
        <MarkdownEditor
          ref={editorRef}
          noteId={noteId}
          initialDoc={loadStatus === "loaded" && !reindexing ? content : ""}
          onChange={handleEditorChange}
          onH1Change={handleEditorH1Change}
          onHeadingsChange={handleEditorHeadingsChange}
          onSaveRequested={handleSaveRequested}
          onBlur={handleEditorBlur}
          readOnly={isDeleted}
          onOpenFind={onOpenFind}
          onOpenFindReplace={onOpenFindReplace}
        />
      </div>
    </section>
  );
}

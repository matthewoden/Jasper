/**
 * EditorPane — a thin view over the per-note noteBufferController.
 *
 * Content, save state, debounce, coalesced flush and WS reconciliation all live
 * in the controller: exactly one buffer per open note however many panes show
 * it (WS-10). This file keeps only pane-local UI.
 *
 * Reindex/connection gating and refreshTree are wired HERE via setSaveGate and
 * subscribeRenamed, so the controller itself stays React-free.
 *
 * When noteId changes on a mounted instance (the no-tabs fallback pane), the
 * previous note's pending debounce is DISCARDED — never saved cross-note.
 */

import {
  Fragment,
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  breadcrumbSegments,
  type BreadcrumbSegment,
} from "../lib/breadcrumbPrefix";
import {
  computeBreadcrumbMaxWidth,
  computeChromeVisibility,
} from "../lib/editorChromeResponsive";
import { extractH1FromContent } from "../lib/h1Extract";
import {
  getNote,
  getNoteFresh,
  staleWriteComparator,
  updateNote,
} from "../lib/notesApi";
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
import { useBookmarks } from "../lib/useBookmarks";
import { useOutlineStore } from "../lib/useOutlineStore";
import type { HeadingInfo } from "../editor/outlineExtract";
import type { components } from "../api/schema";
import type { SearchQuery } from "@codemirror/search";
import { Star } from "lucide-react";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";
import { expandAndScrollToFolder } from "./fileTree.utils";
import { NoteOptionsMenu } from "./NoteOptionsMenu";
import { TitleElement } from "./TitleElement";
import { Tooltip } from "./Tooltip";

import { FilePreviewView } from "./FilePreviewView";

type LoadStatus = "loading" | "loaded" | "error";


type WSNoteUpdatedPayload = components["schemas"]["WSNoteUpdatedPayload"];
type WSNoteDeletedPayload = components["schemas"]["WSNoteDeletedPayload"];

/** Handler ref written by EditorPane on mount so App can dispatch WS events into this editor. */
export interface EditorPaneHandlers {
  onNoteUpdated: (p: WSNoteUpdatedPayload) => void;
  onNoteDeleted: (p: WSNoteDeletedPayload) => void;
  /**
   * Search commands (WS-09) — delegate straight to the internal
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
  /** Returns focus to this pane's editor — Esc closes the Find bar and refocuses. */
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
  /** display:none when true; CM6 stays mounted so cursor/scroll/undo survive (keep-alive). */
  hidden?: boolean;
  /**
   * Gates programmatic autofocus to the ACTIVE pane. Without it every visible
   * pane's editor focuses on mount, so on a reload the last note to load wins
   * DOM focus and overrides the restored active pane non-deterministically.
   */
  paneActive?: boolean;
  /** Read-only + suppress the in-pane deletion banner; the tab pill owns the "(deleted)" indicator. */
  isDeleted?: boolean;
  /** tab-close awaits flush() to persist pending edits before the tab is removed (TAB-13). */
  flushRef?: MutableRefObject<{ flush: () => Promise<void> } | null>;
  /** Cmd+F handler (WS-09) — opens this pane's find-only bar. */
  onOpenFind?: () => void;
  /** Cmd+Opt+F handler (WS-09) — opens this pane's find+replace bar. */
  onOpenFindReplace?: () => void;
  /**
   * Leaf-owned Find/Replace bar, rendered
   * between the breadcrumb header and the note body; passed only to the
   * ACTIVE tab's pane by LeafPane (findBar state/handlers stay in LeafPane —
   * this is pure slot injection, not a state hoist).
   */
  findBarSlot?: React.ReactNode;
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

export function EditorPane({ noteId, reindexing = false, editorHandlersRef, style, autosaveMs, hidden = false, paneActive = true, isDeleted = false, flushRef, onOpenFind, onOpenFindReplace, findBarSlot }: EditorPaneProps) {
  const autosaveMsRef = useRef(autosaveMs ?? AUTOSAVE_DEBOUNCE_MS);
  // Follow prop updates: panes mount before the async /config fetch resolves,
  // so a mount-only capture would pin them to the default interval forever.
  useEffect(() => {
    autosaveMsRef.current = autosaveMs ?? AUTOSAVE_DEBOUNCE_MS;
  }, [autosaveMs]);

  // Per-note controller: a stable singleton per noteId, shared by
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
  // freshly-split pane always shows its OWN metadata bar.
  const controllerNotePath = useSyncExternalStore(
    subscribeController,
    () => controller?.getNotePath() ?? "",
  );

  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const { tree, refresh: refreshTree } = useFileTree();

  const connectionStatus = useTreeStore((s) => s.connectionStatus);

  const activeFilePath = useTreeStore((s) => s.activeFilePath);

  const toggleExpanded = useTreeStore((s) => s.toggleExpanded);
  const setPulseTarget = useTreeStore((s) => s.setPulseTarget);
  const setNotesSidebarVisible = useTreeStore((s) => s.setNotesSidebarVisible);
  const activeNoteId = useTreeStore((s) => s.activeNoteId);
  const zen = useTreeStore((s) => s.zen);

  // Breadcrumb bookmark star (BOOK-01). Renders in every visible pane's
  // breadcrumb (not just the active pane) so a note can be bookmarked from any
  // pane; each pane's star reflects and toggles its OWN note's bookmark state.
  const { isBookmarked, toggleBookmark } = useBookmarks();
  const bookmarked = noteId !== null && isBookmarked(noteId);
  const showBookmarkStar = !hidden && noteId !== null;

  // Responsive top-chrome: word count moved out to the status bar
  // #3/#6): the star hides first at narrow bar widths, the ⋯ menu never
  // hides. Widths are measured (not guessed from viewport) so split-pane
  // layouts respond to THEIR OWN pane width, not the window's.
  // computeChromeVisibility/computeBreadcrumbMaxWidth are pure — the effect
  // below only feeds them a measured clientWidth (mirrors TabStrip's
  // ResizeObserver + pure-function split).
  const chromeBarRef = useRef<HTMLDivElement>(null);
  const chromeClusterRef = useRef<HTMLDivElement>(null);
  const [chromeBarWidth, setChromeBarWidth] = useState(0);
  const [chromeClusterWidth, setChromeClusterWidth] = useState(0);
  const chromeVisibility = useMemo(
    () => computeChromeVisibility(chromeBarWidth),
    [chromeBarWidth],
  );
  const breadcrumbMaxWidth = useMemo(
    () =>
      computeBreadcrumbMaxWidth({
        barWidth: chromeBarWidth,
        clusterWidth: chromeClusterWidth,
      }),
    [chromeBarWidth, chromeClusterWidth],
  );

  useLayoutEffect(() => {
    const bar = chromeBarRef.current;
    const cluster = chromeClusterRef.current;
    if (!bar || !cluster) return;

    const measure = () => {
      // clientWidth 0 (initial mount / jsdom, no real layout) — leave
      // everything visible/unreserved rather than over-hiding against a
      // zero-width budget (same escape hatch TabStrip's measure() uses).
      setChromeBarWidth((prev) => (prev === bar.clientWidth ? prev : bar.clientWidth));
      setChromeClusterWidth((prev) =>
        prev === cluster.clientWidth ? prev : cluster.clientWidth,
      );
    };

    measure();
    // Guard against resize-frame thrash: ResizeObserver only ever writes
    // state when a measurement actually changed (the prev===next checks
    // above), so a flurry of same-size callback firings is a no-op re-render.
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    ro.observe(cluster);
    return () => ro.disconnect();
    // controllerNotePath (not the later-derived `notePath`, which is computed
    // after this hook to respect rules-of-hooks) re-attaches the observer
    // whenever the bar/cluster DOM nodes remount for a new note.
  }, [controllerNotePath]);

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
  // Note-options "Rename" (CTX-03) reuses the existing inline-title
  // rename affordance (H1-is-the-filename binding, TitleElement) rather than
  // a separate rename modal — focusing + selecting the title's text lets the
  // user immediately start typing a replacement, same as clicking into it.
  const titleWrapperRef = useRef<HTMLDivElement>(null);
  const handleRequestRename = useCallback(() => {
    const el = titleWrapperRef.current?.querySelector<HTMLElement>(".editor-title-element");
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, []);
  // ArrowUp from the body's first visible line: places the
  // DOM caret in the title at the measured pixel-X, column-preserving across
  // the CM6-view <-> plain-contentEditable boundary.
  // document.caretRangeFromPoint has no CM6 equivalent for a
  // plain DOM element — it is the only way to convert a pixel X back into a
  // Range/offset within the title's text node.
  const handleCrossToTitle = useCallback((measuredX: number) => {
    const el = titleWrapperRef.current?.querySelector<HTMLElement>(".editor-title-element");
    if (!el) return;
    el.focus();
    const selection = window.getSelection();
    const rect = el.getBoundingClientRect();
    const titleMidY = rect.top + rect.height / 2;
    const range = document.caretRangeFromPoint?.(measuredX, titleMidY);
    if (range && selection) {
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    // Fallback (no caretRangeFromPoint support): land at the end of the title.
    const fallbackRange = document.createRange();
    fallbackRange.selectNodeContents(el);
    fallbackRange.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(fallbackRange);
  }, []);
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
    // setSaveGate is multi-owner — it returns
    // an unregister function scoped to THIS pane's gate only. Returning it
    // directly as the effect cleanup means one pane's unmount can no longer
    // null out a gate that a surviving sibling pane on the same note still
    // relies on.
    return controller.setSaveGate(
      () => !reindexingRef.current && connectionStatusRef.current === "connected",
    );
  }, [controller]);

  // autosaveMs can arrive after mount (async /config fetch) — push it
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

  // Keep the controller's rename-comparator path in sync with
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

  // Deps are intentionally EMPTY: release must happen on true unmount only. On
  // a mere noteId switch, releaseController's flush-before-release would save
  // the abandoned note's buffer — the cross-note PUT this must never do.
  // discardPendingEdit handles that transition instead.
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
    // edit and the save would write it under the wrong note — the
    // cross-note corruption guard.
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
          data.etag,
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
    // paletteOpen guard: without it, a note that
    // finishes loading into a JUST-split pane (e.g. splitPane's cloneActiveTab
    // path, or a slow getNote() resolving late) steals DOM focus out from
    // under the Cmd+O/Cmd+P/Cmd+Shift+F palette if the user opened it in the
    // same beat — reproduced by a real-browser flake where Cmd+Shift+Enter
    // landed on whatever this effect had just refocused instead of the
    // palette's own input. The palette already autofocuses itself on mount;
    // this pane must not fight it for focus while it's open.
    if (
      !hidden &&
      paneActive &&
      loadStatus === "loaded" &&
      noteId !== null &&
      !useTreeStore.getState().paletteOpen
    ) {
      editorRef.current?.focus();
    }
  }, [hidden, paneActive, loadStatus, noteId]);

  const prevConnectionStatusRef = useRef(connectionStatus);

  useEffect(() => {
    const prev = prevConnectionStatusRef.current;
    if (prev !== connectionStatus && prev !== "connected" && connectionStatus === "connected") {
      // Reconnect-flush: a debounced save blocked by the closed gate
      // while disconnected never fired; retry once the gate re-opens.
      // flush() itself no-ops when there is nothing pending.
      if (controller) {
        controller.reportConnectionChange(true);
        void controller.flush().catch(() => {
          // Best-effort retry — failures already surface via saveState.
        });
      }
    } else if (
      prev !== connectionStatus &&
      prev === "connected" &&
      connectionStatus !== "connected"
    ) {
      // Disconnect half — symmetric with the reconnect-flush above. Flips
      // saveState to "paused" so SaveIndicator shows the CloudOff state
      // (dropped by the 25-05 controller-bridging refactor).
      controller?.reportConnectionChange(false);
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

  // The heading flush closes a commit-ordering race: MarkdownEditor's mount-time
  // push is a CHILD effect in the same commit as the tab-open render, while the
  // activeNoteId mirror is a PARENT effect that lands one render later. On a
  // brand-new tab the guard therefore saw a stale activeNoteId and dropped the
  // initial push, leaving Outline on "No headings" until the first live edit.
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
  // tab-close flow so a closing tab never drops mid-debounce edits (TAB-13).
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
    // Carries the same If-Match the controller's own saves do. A closing tab
    // holding stale edits is the sharpest form of the lost-write bug: nothing
    // is watching, so an unconditional PUT destroys another session's work
    // silently. On 409 the write is refused and these edits are lost instead —
    // the correct trade, and the only one available to a page that is going
    // away before it could show a banner.
    const sendKeepaliveSave = (id: string) => {
      const etag = controllerRef.current?.getETag();
      void fetch(`/api/v1/notes/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Session-ID": generateOrLoadSessionId(),
          ...(etag ? { "If-Match": etag } : {}),
        },
        body: JSON.stringify({ content: latestContentRef.current }),
        keepalive: true,
      });
    };
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
      sendKeepaliveSave(id);
    };
    const onBeforeUnload = () => {
      if (keepaliveSentRef.current) return;
      const id = noteIdRef.current;
      if (id === null) return;
      if (connectionStatusRef.current !== "connected") return;
      if (!userHasEdited.current) return;
      if (useTreeStore.getState().vaultSwitching.active) return;
      keepaliveSentRef.current = true;
      sendKeepaliveSave(id);
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
  // of how many panes have this note open — no per-pane fan-out.
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

  // Search commands (WS-09) — thin delegates to the internal
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

  // activeFilePath is a single GLOBAL value in
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
            // 22px top matches the live editor's own top padding (31-03, tightened).
            padding: zen ? "64px 32px" : "22px 56px 200px",
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

  // Inline title: the H1 IS the title. When a note has no H1
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
                  const currentUpdatedAt = staleWriteComparator(result.error);
                  if (currentUpdatedAt !== null) {
                    controller.setH1RenameError(null);
                    controller.setConflict({ visible: true, currentUpdatedAt });
                    return;
                  }
                  const msg =
                    (result.error as { message?: string }).message ??
                    "save failed";
                  let recoveryHint =
                    "Save failed — try Discard or close the banner and retry on next sync.";
                  try {
                    const fresh = await getNoteFresh(id);
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
                // Adopt the token this write just produced. Skipping it would
                // leave the controller comparing against the version the user
                // just chose to overwrite, so every later autosave would 409.
                if (result.data) controller.setETag(result.data.etag);
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
                const { data, error } = await getNoteFresh(id);
                if (id !== noteIdRef.current) return;
                if (error || !data) {
                  const msg =
                    (error as { message?: string } | undefined)?.message ??
                    "couldn't load latest version";
                  controller.setH1RenameError(`Discard failed: ${msg}. Try again.`);
                  return;
                }
                controller.hydrate(data.content, data.path, data.etag);
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
          single source of that signal under the tab model. */}
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
        // Full-pane-width top-chrome bar: this wrapper is the position:relative
        // anchor both the breadcrumb (absolutely centered in the FULL bar,
        //) and the right cluster (pinned to the bar's true
        // right edge) position against — neither is constrained to the
        // 760px reading column anymore (that column framing was removed;
        // the title/body column below stays untouched and independent).
        <div
          ref={chromeBarRef}
          data-testid="editor-top-chrome"
          style={{ position: "relative", height: 40, width: "100%", flexShrink: 0 }}
        >
          <nav
            data-testid="note-breadcrumb"
            aria-label="Note path"
            style={{
              // Spans the full bar (inset:0) and centers its single child via
              // justify-content — this is the "relative container with the
              // breadcrumb absolutely centered" shape the owner asked for
              // 3 #4, replacing the old maxWidth:760 + margin:auto column
              // framing (which centered the breadcrumb against the title/body
              // column, not the bar itself).
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 var(--editor-content-x)",
              boxSizing: "border-box",
            }}
          >
            <div
              data-testid="breadcrumb-content"
              style={{
                display: "flex",
                alignItems: "center",
                minWidth: 0,
                overflow: "hidden",
                boxSizing: "border-box",
                fontSize: 12,
                // Caps the centered block's width so it never grows into the
                // right cluster (computeBreadcrumbMaxWidth) —
                // undefined at jsdom's pre-layout escape hatch means no cap.
                ...(breadcrumbMaxWidth !== undefined ? { maxWidth: breadcrumbMaxWidth } : {}),
              }}
            >
              {breadcrumbSegments(notePath).map((seg, i, arr) => {
                const isLast = i === arr.length - 1;
                return (
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
                        textAlign: "left",
                        padding: "0 2px",
                        borderRadius: 2,
                        lineHeight: "inherit",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flexGrow: 0,
                        // Folder segments give way FIRST: a hard cap + a much
                        // higher flex-shrink weight than the title's (below)
                        // means the shrink algorithm drains almost all
                        // negative space from folder segments before the
                        // title loses any width — the title only truncates
                        // once every folder segment has hit its own
                        // ellipsis floor (minWidth), i.e. as a last resort.
                        ...(isLast
                          ? { flexShrink: 1, minWidth: 0 }
                          : { flexShrink: 20, maxWidth: 140, minWidth: 20 }),
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
                          flexShrink: 0,
                        }}
                      >
                        /
                      </span>
                    )}
                  </Fragment>
                );
              })}
            </div>
          </nav>
          {/* Right-pinned cluster (star -> ⋯), aligned with the tab strip:
              pinned `right: 8px` — NOT
              --editor-content-x (56px, that inset was read as "too far from
              the edge") — matching the tab strip's own pinned-right button
              offset (TabStrip.tsx's newTabButtonStyle / TabOverflowDropdown's
              triggerButtonStyle: 4px strip padding + 4px button margin = 8px
              from the strip's true right edge). Same 8px offset here puts ⋯
              directly beneath the tab strip's +/⌄ buttons above it. The ⋯
              menu is NEVER hidden; the star hides first as the bar narrows
              (computeChromeVisibility). Word count moved out of this cluster
              entirely — it now lives in the bottom StatusBar. */}
          <div
            ref={chromeClusterRef}
            data-testid="editor-top-chrome-cluster"
            style={{
              position: "absolute",
              right: 8,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {showBookmarkStar && chromeVisibility.showStar && noteId !== null && (
              <Tooltip label={bookmarked ? "Remove bookmark" : "Bookmark this note"} side="bottom">
                <button
                  type="button"
                  data-testid="bookmark-star"
                  aria-label={bookmarked ? "Remove bookmark" : "Bookmark this note"}
                  onClick={() => {
                    void toggleBookmark(noteId);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: bookmarked
                      ? "var(--color-accent)"
                      : "var(--color-muted)",
                  }}
                >
                  <Star
                    size={16}
                    aria-hidden="true"
                    fill={bookmarked ? "currentColor" : "none"}
                  />
                </button>
              </Tooltip>
            )}
            {!hidden && notePath && (
              <NoteOptionsMenu
                noteId={noteId}
                notePath={notePath}
                onOpenFind={onOpenFind}
                onOpenFindReplace={onOpenFindReplace}
                onRequestRename={handleRequestRename}
              />
            )}
          </div>
        </div>
      )}
      {/* Leaf-owned Find/Replace bar slot:
          tabStrip -> breadcrumb (above) -> findBar (here) -> body (below).
          Only the active tab's EditorPane receives a non-undefined slot
          (LeafPane); every other tab renders nothing here. */}
      {findBarSlot}
      {/* Title element (READ-01): inside the same 760px column,
          sharing its 56px horizontal padding (NOT --editor-content-x, which
          is the breadcrumb's pane-wide chrome padding). Reads/writes
          through the EXISTING onH1Change/rewriteH1 binding via the
          MarkdownEditor ref's setH1 — no second rename pathway. */}
      <div
        ref={titleWrapperRef}
        className="editor-title-wrapper"
        style={{
          width: "100%",
          maxWidth: zen ? 700 : 760,
          margin: "0 auto",
          // paddingTop gives the title a little breathing
          // room below the chrome bar — a modest bump off the prior flush 0,
          // on the 4px spacing scale. paddingBottom is untouched: it still
          // combines with .cm-content's own top padding (themeBridge.ts) for
          // the ~28px title->body gap — don't
          // touch that math here.
          padding: zen ? "8px 32px 6px" : "8px 56px 6px",
          boxSizing: "border-box",
        }}
      >
        <TitleElement
          title={titleFallback}
          onTitleChange={(next) => editorRef.current?.setH1(next)}
          onFocusHandoff={(measuredX) => editorRef.current?.enterFromTitle(measuredX)}
        />
      </div>
      {/* MarkdownEditor is uncontrolled — initialDoc captured once on mount;
          updates flow through the ref API. Click-anywhere-to-type: clicks outside
          .cm-content call focusEnd() to move caret to end-of-doc.
          The shell carries NO horizontal padding: the reading column is the
          self-centering 760px .cm-content (margin:0 auto). Adding
          --editor-content-x here (pane-wide breadcrumb chrome) would shift
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
          onCrossToTitle={handleCrossToTitle}
        />
      </div>
    </section>
  );
}

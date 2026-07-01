/**
 * EditorPane — MarkdownEditor (CM6) + load on noteId-change + 2s debounced
 * autosave + Cmd+S immediate save + in-flight save coalescing.
 *
 * When noteId is null, renders a locked placeholder with no API calls.
 * When noteId changes, the load effect re-runs and the save-state machine
 * resets for the new note.
 *
 * H1→filename binding: when the H1 in the editor changes, the next debounced
 * save detects the delta, sanitizes the new heading via the same illegal-char
 * regex RenameInput uses, and dispatches postNoteMove BEFORE updateNote.
 * On move failure (e.g. case_collision), the save aborts and surfaces a banner.
 * A single isRenameInProgress ref short-circuits the detector while a move is
 * in flight to prevent rename loops. Empty H1 → no-op.
 *
 * WebSocket sync: subscribes to connectionStatus for the autosave gate.
 * Exposes onNoteUpdated / onNoteDeleted handlers via editorHandlersRef so
 * App's useSessionSync can dispatch WS events directly into this editor.
 */

import {
  Fragment,
  type MutableRefObject,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  breadcrumbSegments,
  type BreadcrumbSegment,
} from "../lib/breadcrumbPrefix";
import { extractH1FromContent, sanitizeH1ForFilename } from "../lib/h1Extract";
import { getNote, updateNote } from "../lib/notesApi";
import { generateOrLoadSessionId } from "../lib/sessionId";
import { dispatchTagEvent } from "../lib/useTagBrowser";
import {
  initialSaveState,
  saveStateReducer,
} from "../lib/saveStateMachine";
import { postNoteMove, type Tree, type TreeNode } from "../lib/treeApi";
import { useFileTree } from "../lib/useFileTree";
import { useTreeStore } from "../lib/useTreeStore";
import type { components } from "../api/schema";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";
import { expandAndScrollToFolder } from "./fileTree.utils";

import { FilePreviewView } from "./FilePreviewView";

type LoadStatus = "loading" | "loaded" | "error";


type WSNoteUpdatedPayload = components["schemas"]["WSNoteUpdatedPayload"];
type WSNoteDeletedPayload = components["schemas"]["WSNoteDeletedPayload"];

/** Handler ref written by EditorPane on mount so App can dispatch WS events into this editor. */
export interface EditorPaneHandlers {
  onNoteUpdated: (p: WSNoteUpdatedPayload) => void;
  onNoteDeleted: (p: WSNoteDeletedPayload) => void;
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
  /** Autosave debounce interval in ms. Captured to a ref at mount so interval is stable per session. */
  autosaveMs?: number;
  /** display:none when true; CM6 stays mounted so cursor/scroll/undo survive (keep-alive, D-01). */
  hidden?: boolean;
  /** Read-only + suppress the in-pane deletion banner; the tab pill owns the "(deleted)" indicator (D-10). */
  isDeleted?: boolean;
  /** tab-close awaits flush() to persist pending edits before the tab is removed (TAB-13). */
  flushRef?: MutableRefObject<{ flush: () => Promise<void> } | null>;
}


function parentDirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function composeNewPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
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

export function EditorPane({ noteId, reindexing = false, editorHandlersRef, style, autosaveMs, hidden = false, isDeleted = false, flushRef }: EditorPaneProps) {
  const autosaveMsRef = useRef(autosaveMs ?? AUTOSAVE_DEBOUNCE_MS);

  const [content, setContent] = useState("");
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [saveState, dispatch] = useReducer(
    saveStateReducer,
    initialSaveState,
  );
  const { tree, refresh: refreshTree } = useFileTree();
  const [h1RenameError, setH1RenameError] = useState<string | null>(null);

  const connectionStatus = useTreeStore((s) => s.connectionStatus);

  const activeFilePath = useTreeStore((s) => s.activeFilePath);

  const toggleExpanded = useTreeStore((s) => s.toggleExpanded);
  const setPulseTarget = useTreeStore((s) => s.setPulseTarget);
  const setNotesSidebarVisible = useTreeStore((s) => s.setNotesSidebarVisible);
  const activeNoteId = useTreeStore((s) => s.activeNoteId);

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

  const [conflictBanner, setConflictBanner] = useState<{
    visible: boolean;
    currentUpdatedAt: string;
  } | null>(null);

  const [deletedBanner, setDeletedBanner] = useState<{
    visible: boolean;
    deletedPath: string;
  } | null>(null);

  const editorRef = useRef<MarkdownEditorRef>(null);
  const latestContentRef = useRef("");
  const debounceTimer = useRef<number | null>(null);
  const savedTimer = useRef<number | null>(null);
  const inFlight = useRef(false);
  const trailingPending = useRef(false);
  const userHasEdited = useRef(false);
  const noteIdRef = useRef<string | null>(noteId);
  useEffect(() => {
    noteIdRef.current = noteId;
  }, [noteId]);

  const connectionStatusRef = useRef(connectionStatus);
  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);

  useEffect(() => {
    useTreeStore.getState().setSaveState(saveState);
  }, [saveState]);

  const keepaliveSentRef = useRef(false);

  const lastH1Sent = useRef<string | null>(null);
  const isRenameInProgress = useRef(false);
  const lastNotePath = useRef<string>("");

  useEffect(() => {
    if (noteId === null) return;
    const livePath = findNotePathInTree(tree, noteId);
    if (livePath !== null && livePath !== lastNotePath.current) {
      lastNotePath.current = livePath;
    }
  }, [tree, noteId]);

  const prevNoteIdRef = useRef<string | null>(noteId);

  useEffect(() => {
    {
      const prevId = prevNoteIdRef.current;
      if (prevId !== null && prevId !== noteId && userHasEdited.current) {
        useTreeStore.getState().clearLiveLabel(prevId);
      }
      prevNoteIdRef.current = noteId;
    }
    if (noteId === null) {
      setLoadStatus("loaded");
      setContent("");
      latestContentRef.current = "";
      userHasEdited.current = false;
      lastH1Sent.current = null;
      lastNotePath.current = "";
      isRenameInProgress.current = false;
      setH1RenameError(null);
      setConflictBanner(null);
      setDeletedBanner(null);
      return;
    }
    const abortCtrl = new AbortController();
    setLoadStatus("loading");
    userHasEdited.current = false;
    setH1RenameError(null);
    setConflictBanner(null);
    setDeletedBanner(null);
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
        setContent(data.content);
        latestContentRef.current = data.content;
        editorRef.current?.applyServerUpdate(data.content);
      }
      lastH1Sent.current = extractH1FromContent(data.content);
      lastNotePath.current = data.path;
      setLoadStatus("loaded");
    })();
    return () => {
      abortCtrl.abort();
    };
  }, [noteId]);

  useEffect(() => {
    if (!hidden && loadStatus === "loaded" && noteId !== null) {
      editorRef.current?.focus();
    }
  }, [hidden, loadStatus, noteId]);

  const reindexingRef = useRef(reindexing);
  useEffect(() => {
    reindexingRef.current = reindexing;
  }, [reindexing]);

  const prevConnectionStatusRef = useRef(connectionStatus);

  const performSave = useCallback(async (latestContent: string): Promise<{ ok: boolean }> => {
    if (reindexingRef.current) return { ok: false };
    const id = noteIdRef.current;
    if (id === null) return { ok: false };
    if (connectionStatusRef.current !== "connected") return { ok: false };
    if (inFlight.current) {
      // A save is already running; this content rides out as the trailing save.
      trailingPending.current = true;
      return { ok: true };
    }
    inFlight.current = true;
    dispatch({ type: "requestSave" });
    try {
      const currentH1 = extractH1FromContent(latestContent);
      const h1Changed =
        currentH1 !== null && currentH1 !== lastH1Sent.current;

      if (h1Changed && !isRenameInProgress.current) {
        const sanitized = sanitizeH1ForFilename(currentH1);
        if (!sanitized.ok) {
          setH1RenameError(sanitized.error);
        } else {
          isRenameInProgress.current = true;
          try {
            const parent = parentDirOf(lastNotePath.current);
            const newPath = composeNewPath(
              parent,
              sanitized.value + ".md",
            );
            if (newPath.toLowerCase() !== lastNotePath.current.toLowerCase()) {
              const moveResp = await postNoteMove(id, newPath);
              if (moveResp.error) {
                const msg =
                  moveResp.error.code === "case_collision"
                    ? "Couldn't rename to match the heading — that filename is already taken."
                    : "Couldn't rename to match the heading. Try a different heading.";
                setH1RenameError(msg);
                dispatch({ type: "saveFailed", error: msg });
                return { ok: false };
              }
              if (moveResp.data) {
                lastNotePath.current = moveResp.data.path;
              }
              lastH1Sent.current = currentH1;
              setH1RenameError(null);
            } else {
              lastH1Sent.current = currentH1;
              setH1RenameError(null);
            }
          } finally {
            isRenameInProgress.current = false;
          }
        }
      }

      const { data, error } = await updateNote(id, latestContent);
      if (error || !data) {
        const msg =
          (error as { message?: string } | undefined)?.message ??
          "save failed";
        dispatch({ type: "saveFailed", error: msg });
        return { ok: false };
      }
      if (h1Changed) {
        await refreshTree();
      }
      dispatch({
        type: "saveSucceeded",
        updatedAt: new Date(data.updated_at),
      });
      dispatchTagEvent("tags:updated");
      if (savedTimer.current !== null) {
        window.clearTimeout(savedTimer.current);
      }
      savedTimer.current = window.setTimeout(() => {
        dispatch({ type: "savedTimerExpired" });
      }, SAVED_STICKY_MS);
      return { ok: true };
    } catch (e) {
      dispatch({
        type: "saveFailed",
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false };
    } finally {
      inFlight.current = false;
      if (trailingPending.current) {
        trailingPending.current = false;
        void performSave(latestContentRef.current);
      }
    }
  }, [refreshTree]);

  useEffect(() => {
    const prev = prevConnectionStatusRef.current;
    if (prev !== connectionStatus) {
      if (connectionStatus !== "connected") {
        dispatch({ type: "connectionLost" });
      } else if (prev !== "connected") {
        dispatch({ type: "connectionRestored" });
        if (userHasEdited.current && noteIdRef.current !== null) {
          void performSave(latestContentRef.current);
        }
      }
      prevConnectionStatusRef.current = connectionStatus;
    }
  }, [connectionStatus, performSave]);

  const handleEditorChange = useCallback(
    (next: string) => {
      userHasEdited.current = true;
      setContent(next);
      latestContentRef.current = next;
      dispatch({ type: "edit" });
      if (debounceTimer.current !== null) {
        window.clearTimeout(debounceTimer.current);
      }
      debounceTimer.current = window.setTimeout(() => {
        debounceTimer.current = null;
        void performSave(latestContentRef.current);
      }, autosaveMsRef.current);
    },
    [performSave],
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

  const handleSaveRequested = useCallback(() => {
    if (debounceTimer.current !== null) {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    void performSave(latestContentRef.current);
  }, [performSave]);

  const handleEditorBlur = useCallback(() => {
    if (!userHasEdited.current) return;
    if (debounceTimer.current !== null) {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    void performSave(latestContentRef.current);
  }, [performSave]);

  // flush() — cancel the pending debounce and save synchronously, awaitable by the
  // tab-close flow so a closing tab never drops mid-debounce edits (TAB-13, D-04).
  // Rejects when the save fails so the caller can surface a confirm dialog.
  const flush = useCallback(async () => {
    if (debounceTimer.current !== null) {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (!userHasEdited.current) return;
    const { ok } = await performSave(latestContentRef.current);
    if (!ok) throw new Error("flush failed");
  }, [performSave]);

  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = { flush };
    return () => {
      flushRef.current = null;
    };
  }, [flushRef, flush]);

  useEffect(() => {
    return () => {
      if (debounceTimer.current !== null) {
        window.clearTimeout(debounceTimer.current);
      }
      if (savedTimer.current !== null) {
        window.clearTimeout(savedTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") {
        keepaliveSentRef.current = false;
        return;
      }
      if (debounceTimer.current !== null) {
        window.clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
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
    // refs only — performSave is no longer called from inside the handlers,
    // so the dep array is intentionally empty.
  }, []);


  // When note:updated arrives for the open note with no pending edits/saves, silently
  // re-fetch and replace content. When unsaved edits or a pending save exist, surface
  // the conflict banner instead — never silently overwrite uncommitted work.
  const onNoteUpdated = useCallback(
    (p: WSNoteUpdatedPayload) => {
      if (p.id !== noteIdRef.current) return;
      const debouncePending = debounceTimer.current !== null;
      const inFlightSave = inFlight.current;
      if (!userHasEdited.current && !debouncePending && !inFlightSave) {
        void (async () => {
          try {
            const { data } = await getNote(p.id);
            if (!data) return;
            setContent(data.content);
            latestContentRef.current = data.content;
            editorRef.current?.applyServerUpdate(data.content);
          } catch {
            setConflictBanner({ visible: true, currentUpdatedAt: p.updated_at });
          }
        })();
        return;
      }
      setConflictBanner({ visible: true, currentUpdatedAt: p.updated_at });
    },
    [], // uses refs only (noteIdRef, debounceTimer, inFlight, userHasEdited)
  );

  // note:deleted for the open note → deletion banner; content stays intact for recovery.
  const onNoteDeleted = useCallback(
    (p: WSNoteDeletedPayload) => {
      if (p.id !== noteIdRef.current) return;
      setDeletedBanner({ visible: true, deletedPath: p.path });
    },
    [], // uses refs only
  );

  useEffect(() => {
    if (editorHandlersRef) {
      editorHandlersRef.current = {
        onNoteUpdated,
        onNoteDeleted,
      };
    }
    return () => {
      if (editorHandlersRef) {
        editorHandlersRef.current = null;
      }
    };
  }, [editorHandlersRef, onNoteUpdated, onNoteDeleted]);

  if (activeFilePath !== null) {
    return (
      <section
        className="flex flex-col h-full bg-bg"
        style={{ minHeight: 0, overflow: "hidden", ...style }}
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
        style={style}
      >
        <div
          className="flex items-center justify-center"
          style={{ flex: 1 }}
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
  // segment reveals it in the tree; clicking the title segment pulses the note row.
  const notePath = findNotePathInTree(tree, noteId);

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
                if (id === null) return;
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
                    setH1RenameError(null);
                    setConflictBanner({
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
                      setConflictBanner({
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
                  setH1RenameError(`Couldn't save: ${msg}. ${recoveryHint}`);
                  dispatch({ type: "saveFailed", error: msg });
                  return;
                }
                setH1RenameError(null);
                setConflictBanner(null);
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
                if (!id) return;
                const { data, error } = await getNote(id);
                if (id !== noteIdRef.current) return;
                if (error || !data) {
                  const msg =
                    (error as { message?: string } | undefined)?.message ??
                    "couldn't load latest version";
                  setH1RenameError(`Discard failed: ${msg}. Try again.`);
                  return;
                }
                setH1RenameError(null);
                setContent(data.content);
                latestContentRef.current = data.content;
                userHasEdited.current = false;
                editorRef.current?.applyServerUpdate(data.content);
                setConflictBanner(null);
              })();
            }}
          >
            Discard
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setConflictBanner(null)}
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
            onClick={() => setDeletedBanner(null)}
          >
            ×
          </button>
        </div>
      )}
      {notePath && breadcrumbSegments(notePath).length > 0 && (
        <nav
          data-testid="note-breadcrumb"
          aria-label="Note path"
          style={{
            fontSize: 12,
            padding: "4px var(--editor-content-x)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            textAlign: "center",
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
        </nav>
      )}
      {/* MarkdownEditor is uncontrolled — initialDoc captured once on mount;
          updates flow through the ref API. Click-anywhere-to-type: clicks outside
          .cm-content call focusEnd() to move caret to end-of-doc. Host has zero
          padding so empty-area clicks reach this onClick reliably. */}
      <div
        className="cm-host-shell"
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
          paddingLeft: "var(--editor-content-x)",
        }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest(".cm-content")) return;
          editorRef.current?.focusEnd();
        }}
        data-testid="cm-host-shell"
      >
        <MarkdownEditor
          ref={editorRef}
          initialDoc={loadStatus === "loaded" && !reindexing ? (content ?? "") : ""}
          onChange={handleEditorChange}
          onH1Change={handleEditorH1Change}
          onSaveRequested={handleSaveRequested}
          onBlur={handleEditorBlur}
          readOnly={isDeleted}
        />
      </div>
    </section>
  );
}

/**
 * EditorPane — the editor pane: MarkdownEditor (CM6) + load on mount /
 * noteId-change + 2s debounced autosave + Cmd+S immediate save +
 * in-flight save coalescing, all driving the locked SaveIndicator
 * state machine (Phase 1 Task 1).
 *
 * Plan 05-11 D-27: the old controlled textarea is replaced by a MarkdownEditor
 * (uncontrolled CM6 view) via the ref API. Every Phase 4 wiring remains intact:
 * banners, conflict prompts, deletion banner, autosave + saveStateMachine,
 * h1Extract, editorHandlersRef, userHasEdited, lastNotePath.
 *
 * Phase 3 (Plan 03-07) refactor: the prior single-note model (Phase 1's
 * hardcoded note UUID) is replaced by a `noteId: string | null` prop
 * driven from useTreeStore.activeNoteId. When noteId === null, render
 * the locked placeholder ("Select a note to start editing.") with no
 * API calls. When noteId changes, the load effect re-runs against the
 * new id, the userHasEdited latch resets, and the existing save-state
 * machine is re-initialized for the new note.
 *
 * Plan 03-22 (Gap R2-6 — filename↔H1 bidirectional binding) — DIRECTION A:
 *   When the H1 in the editor changes (e.g. user types "# new title"),
 *   the next debounced performSave detects the H1 delta vs the
 *   most-recently-persisted H1 (lastH1Sent ref), sanitizes it through
 *   the same illegal-char regex RenameInput uses, and dispatches
 *   postNoteMove(id, parent + sanitized + ".md") BEFORE updateNote.
 *   On move success, updateNote then commits the latest content. On
 *   move failure (e.g. case_collision), the save aborts entirely and
 *   surfaces an inline banner so the user can retry with a different
 *   heading. A single isRenameInProgress ref short-circuits the H1
 *   detector while a move is in flight (loop prevention mirroring the
 *   Obsidian plugin's pattern; PROJECT.md Key Decision 2026-05-03 LOCKED).
 *   Empty H1 → no-op (research §2.1: filename does NOT auto-bind when
 *   the H1 is empty). Invalid H1 → soft error: content still saves,
 *   banner explains the rename was skipped.
 *
 * Plan 04-05 (Phase 4 — WebSocket session sync):
 *   - Subscribes to useTreeStore.connectionStatus for autosave gate (D-06).
 *   - Adds conflictBanner + deletedBanner state.
 *   - Renders both banners above the textarea in the banner-stack region (D-01).
 *   - Implements onNoteUpdated: silent reload OR conflict banner (D-10/D-11).
 *   - Implements onNoteDeleted: deletion banner without clearing content (UX-05/D-03).
 *   - Exposes handlers via editorHandlersRef prop (D-09 — no new event bus).
 *   - On connectionStatus !== 'connected': dispatches connectionLost to
 *     saveStateMachine; on reconnect: dispatches connectionRestored (D-06).
 */

import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";

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

import { FilePreviewView } from "./FilePreviewView";

type LoadStatus = "loading" | "loaded" | "error";


type WSNoteUpdatedPayload = components["schemas"]["WSNoteUpdatedPayload"];
type WSNoteDeletedPayload = components["schemas"]["WSNoteDeletedPayload"];

/**
 * Phase 4 (D-09): handler ref shape written by EditorPane on mount so
 * App's useSessionSync can dispatch WS events directly into this editor.
 * Using a plain MutableRefObject ref instead of an event-bus abstraction
 * (no new pub/sub layer needed for a single-pane app).
 */
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
  /**
   * Phase 4 (D-09): handler ref written to by EditorPane on mount so
   * App's useSessionSync can dispatch WS events directly into this editor.
   * No new event-bus abstraction — a plain ref per Plan 04-05.
   */
  editorHandlersRef?: MutableRefObject<EditorPaneHandlers | null>;
  /**
   * Phase 6.6 — Plan 06.6-11: optional style for grid placement.
   * App.tsx passes gridRow/gridColumn here; merged onto the root section.
   */
  style?: React.CSSProperties;
  /**
   * Phase 11 (D-07 / SET-03): autosave debounce interval in ms, read from
   * config.editor.autosaveMs at mount. Defaults to AUTOSAVE_DEBOUNCE_MS
   * (2000) when absent. Captured to a ref at mount so the debounce interval
   * does not change mid-session (D-07 "restart to apply" label).
   */
  autosaveMs?: number;
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

export function EditorPane({ noteId, reindexing = false, editorHandlersRef, style, autosaveMs }: EditorPaneProps) {
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
    if (loadStatus === "loaded" && noteId !== null) {
      editorRef.current?.focus();
    }
  }, [loadStatus, noteId]);

  const reindexingRef = useRef(reindexing);
  useEffect(() => {
    reindexingRef.current = reindexing;
  }, [reindexing]);

  const prevConnectionStatusRef = useRef(connectionStatus);

  const performSave = useCallback(async (latestContent: string) => {
    if (reindexingRef.current) return;
    const id = noteIdRef.current;
    if (id === null) return;
    if (connectionStatusRef.current !== "connected") return;
    if (inFlight.current) {
      trailingPending.current = true;
      return;
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
                return;
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
        return;
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
    } catch (e) {
      dispatch({
        type: "saveFailed",
        error: e instanceof Error ? e.message : String(e),
      });
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


  /**
   * D-10: when note:updated arrives for the OPEN note AND userHasEdited is false
   * AND no debounce/inflight pending, silently re-fetch and replace content;
   * cursor preserved.
   * D-11: when unsaved edits OR pending autosave OR in-flight save, surface the
   * conflict banner (SYNC-05) — never silent overwrite.
   */
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

  /**
   * UX-05 / D-03: note:deleted for the open note → deletion banner; editor
   * content stays intact for recovery. Never clears content state.
   */
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

  return (
    <section
      className="flex flex-col h-full bg-bg"
      style={{ minHeight: 0, overflow: "hidden", position: "relative", ...style }}
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
      {/* Phase 4 (D-01): conflict banner — stacks AFTER h1RenameError, BEFORE textarea */}
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
      {/* Phase 4 (D-01, UX-05, D-03): deletion banner — informational only; no content clear */}
      {deletedBanner?.visible && (
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
      {/* Plan 05-11 D-26..D-27: editor element (MarkdownEditor).
          MarkdownEditor is uncontrolled — initialDoc is captured ONCE on mount.
          Updates flow through the ref API (editorRef). Phase 4 wiring is intact:
          banners, conflictBanner, deletedBanner, autosave, saveStateMachine, h1Extract,
          editorHandlersRef, userHasEdited, lastNotePath all remain in EditorPane.

          Phase 5.5 / UX-10: click-anywhere-to-type host. Clicks that did NOT
          land inside .cm-content (i.e. clicks below the last line / on
          surrounding empty area) call focusEnd() to focus the editor with the
          caret at end-of-doc. Padding stays on .cm-content (themeBridge) — host
          has zero padding so empty-area clicks reach this onClick reliably. */}
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
        />
      </div>
    </section>
  );
}

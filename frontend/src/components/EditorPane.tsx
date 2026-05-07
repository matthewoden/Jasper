/**
 * EditorPane — the editor pane: controlled <textarea> + load on mount /
 * noteId-change + 2s debounced autosave + Cmd+S immediate save +
 * in-flight save coalescing, all driving the locked SaveIndicator
 * state machine (Phase 1 Task 1).
 *
 * Phase 3 (Plan 03-07) refactor: the prior single-note model (Phase 1's
 * hardcoded note UUID) is replaced by a `noteId: string | null` prop
 * driven from useTreeStore.activeNoteId. When noteId === null, render
 * the locked placeholder ("Select a note to start editing.") with no
 * API calls. When noteId changes, the load effect re-runs against the
 * new id, the userHasEdited latch resets, and the existing save-state
 * machine is re-initialized for the new note.
 *
 * Per 01-UI-SPEC.md §"Forward-looking constraint": Phase 5's
 * CodeMirror swap replaces ONLY the <textarea> element. The autosave
 * debounce, Cmd+S handler, coalescing logic, and SaveIndicator remain
 * unchanged.
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
  type ChangeEvent,
  type KeyboardEvent,
  type MutableRefObject,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";

import { extractH1FromContent, sanitizeH1ForFilename } from "../lib/h1Extract";
import { getNote, updateNote } from "../lib/notesApi";
import {
  initialSaveState,
  saveStateReducer,
} from "../lib/saveStateMachine";
import { postNoteMove, type Tree, type TreeNode } from "../lib/treeApi";
import { useFileTree } from "../lib/useFileTree";
import { useTreeStore } from "../lib/useTreeStore";
import { SaveIndicator } from "./SaveIndicator";
import type { components } from "../api/schema";

type LoadStatus = "loading" | "loaded" | "error";

// Amendment 2 — schema-typed WS payload type aliases for Phase 4.
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

// Locked timing constants (UI-SPEC §Save-trigger timing). Exported as named
// consts so the verification grep can prove they exist; Phase 5 reuses them.
export const AUTOSAVE_DEBOUNCE_MS = 2000;
export const SAVED_STICKY_MS = 2000;

const LOAD_ERROR_COPY =
  "Could not load note. Check that the server is running, then refresh the page.";

// Phase 2 (UI-SPEC §Surface 3 + §Layout Contract): when reindexing=true the
// textarea disables and shows this placeholder. App.tsx mounts the
// <ReindexProgress /> overlay in the editor pane's place during a real
// reindex; this prop is the in-component guard so save attempts that race
// the unmount cannot leak through.
const REINDEXING_PLACEHOLDER = "Index is rebuilding…";

// Phase 3 (Plan 03-07 §Surface): null noteId placeholder copy.
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
}

// ────────────────────────────────────────────────────────────────────
// Plan 03-22 — pure path helpers used by the H1-rename branch.
//
// Mirrors the (currently duplicated) basename / composeNewPath pair in
// FileTree.tsx. A future refactor should lift both pairs to a shared
// frontend/src/lib/pathUtil.ts; for now duplicating two ~5-LOC helpers
// is the project's accepted convention (mirrors the Go-side
// validateBareName ↔ JS validateRename pattern).
// ────────────────────────────────────────────────────────────────────
function parentDirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function composeNewPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

// CR-02 fix — walk the live tree to recover the active note's CURRENT path.
// EditorPane previously cached lastNotePath in a ref that was only refreshed
// on noteId change or after EditorPane's own postNoteMove. Tree-side renames
// (FileTree.handleCommitRename → moveNote) leave the ref pointing at the
// PRE-rename path, and the next H1 edit silently relocates the file based on
// that stale parent. Reading from the live tree closes that window.
function findNotePathInTree(tree: Tree | null, noteId: string): string | null {
  if (tree === null) return null;
  const visit = (node: TreeNode): string | null => {
    if (node.kind === "note") {
      return node.id === noteId ? node.path : null;
    }
    if (node.children) {
      for (const child of node.children) {
        const hit = visit(child);
        if (hit !== null) return hit;
      }
    }
    return null;
  };
  for (const node of tree.root) {
    const hit = visit(node);
    if (hit !== null) return hit;
  }
  return null;
}

export function EditorPane({ noteId, reindexing = false, editorHandlersRef }: EditorPaneProps) {
  const [content, setContent] = useState("");
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [saveState, dispatch] = useReducer(
    saveStateReducer,
    initialSaveState,
  );
  // Plan 03-23 — broadcast-refresh hook for Direction A. After a
  // successful Direction A move, we must trigger the same broadcast
  // refresh that useTreeMutations.moveNote uses, so the FileTree
  // re-fetches GET /tree (which now carries the fresh title via
  // Service.Move's Plan-03-21 title refresh) and the tree row label
  // updates in the live browser. Without this, the move succeeds on the
  // wire but the user sees a stale label until reload — exactly the
  // false-positive surface that Plan 03-23's Scenario G is designed to
  // catch.
  const { tree, refresh: refreshTree } = useFileTree();
  // Plan 03-22 (Gap R2-6) — surface for the H1-rename failure path.
  // Soft errors (illegal H1) and hard errors (case_collision on move)
  // both render here as a thin banner above the textarea. Cleared on
  // every successful H1 round-trip OR when the H1 stops being invalid.
  const [h1RenameError, setH1RenameError] = useState<string | null>(null);

  // Phase 4 (Plan 04-05) — connection status for autosave gate (D-06).
  const connectionStatus = useTreeStore((s) => s.connectionStatus);

  // Phase 4 (Plan 04-05) — conflict banner (SYNC-05, D-11).
  const [conflictBanner, setConflictBanner] = useState<{
    visible: boolean;
    currentUpdatedAt: string;
  } | null>(null);

  // Phase 4 (Plan 04-05) — deletion banner (UX-05, D-03).
  const [deletedBanner, setDeletedBanner] = useState<{
    visible: boolean;
    deletedPath: string;
  } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Latest content the component has seen — read by the trailing-save closure
  // when an in-flight PUT resolves. Using a ref avoids stale closures and
  // means the trailing save uses the freshest value.
  const latestContentRef = useRef("");
  const debounceTimer = useRef<number | null>(null);
  const savedTimer = useRef<number | null>(null);
  const inFlight = useRef(false);
  // Exactly-one trailing save coalescing — UI-SPEC §Save-trigger timing.
  const trailingPending = useRef(false);
  // CR-04: tracks whether the user has typed since (re-)mount / noteId
  // change. The load effect only seeds latestContentRef before any
  // typing — under React 19 StrictMode the load effect runs twice, and
  // a stale GET resolving after the user starts typing would otherwise
  // clobber the typed text.
  const userHasEdited = useRef(false);
  // Pin the noteId in a ref so the save callback (memoized with stable
  // identity) reads the current value without rebinding the whole hook
  // chain when noteId changes.
  const noteIdRef = useRef<string | null>(noteId);
  useEffect(() => {
    noteIdRef.current = noteId;
  }, [noteId]);

  // Phase 4 (D-06) — keep a ref to connectionStatus to allow the save
  // callback (stable memoized identity) to read it without stale closure.
  const connectionStatusRef = useRef(connectionStatus);
  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);

  // Plan 03-22 (Gap R2-6) — H1-driven rename pipeline state.
  //   lastH1Sent       tracks the most-recently-persisted H1 so we
  //                    know when the H1 has changed since the last
  //                    save (and a moveNote is needed). Seeded to
  //                    extractH1FromContent(loadedContent) on mount.
  //   isRenameInProgress  loop-prevention flag mirroring the Obsidian
  //                    plugin's pattern. While set, the H1-change
  //                    detector skips dispatching another moveNote.
  //   lastNotePath     caches the canonical post-load (or post-move)
  //                    path so we can compute the parent directory
  //                    for the new filename. Updated from the move
  //                    response on every successful rename.
  const lastH1Sent = useRef<string | null>(null);
  const isRenameInProgress = useRef(false);
  const lastNotePath = useRef<string>("");

  // CR-02 fix — keep lastNotePath in sync with the LIVE tree so tree-side
  // renames of the active note (FileTree.handleCommitRename → moveNote)
  // are observed without needing to remount EditorPane. Falls back to the
  // load-effect's seed value when the tree hasn't fetched yet OR the note
  // hasn't appeared in the tree yet (race during very-first mount). The
  // load effect is still authoritative for the initial seed; this effect
  // only updates on subsequent tree changes.
  useEffect(() => {
    if (noteId === null) return;
    const livePath = findNotePathInTree(tree, noteId);
    if (livePath !== null && livePath !== lastNotePath.current) {
      lastNotePath.current = livePath;
    }
  }, [tree, noteId]);

  // 1. Load on mount AND whenever noteId changes (Phase 3).
  useEffect(() => {
    if (noteId === null) {
      // No note selected — leave the component in a non-loading,
      // non-error state. The placeholder branch below renders before
      // we reach the textarea path.
      setLoadStatus("loaded");
      setContent("");
      latestContentRef.current = "";
      userHasEdited.current = false;
      // Plan 03-22 — reset H1-binding state too. If the user later
      // selects a different note, the load effect re-runs and seeds
      // these from the new content.
      lastH1Sent.current = null;
      lastNotePath.current = "";
      isRenameInProgress.current = false;
      setH1RenameError(null);
      // Phase 4 — clear banners on note switch.
      setConflictBanner(null);
      setDeletedBanner(null);
      return;
    }
    let cancelled = false;
    setLoadStatus("loading");
    userHasEdited.current = false;
    // Plan 03-22 — clear the rename error banner on note switch so a
    // stale message from the previous note doesn't bleed across.
    setH1RenameError(null);
    // Phase 4 — clear WS banners on note switch.
    setConflictBanner(null);
    setDeletedBanner(null);
    (async () => {
      const { data, error } = await getNote(noteId);
      if (cancelled) return;
      if (error || !data) {
        setLoadStatus("error");
        return;
      }
      // Only seed the textarea + latest-content ref if the user hasn't
      // started typing. Without this guard a slow / double-mount GET
      // can overwrite typed bytes (CR-04).
      if (!userHasEdited.current) {
        setContent(data.content);
        latestContentRef.current = data.content;
      }
      // Plan 03-22 — seed the H1-binding refs from the loaded content
      // and the canonical path returned by the server. The path may
      // include a parent directory; performSave's H1 detector uses it
      // to compose the new path on rename.
      lastH1Sent.current = extractH1FromContent(data.content);
      lastNotePath.current = data.path;
      setLoadStatus("loaded");
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  // 1b. Focus the textarea after the enabled state commits. Running this from
  // the load-effect's promise chain races the disabled→enabled re-render —
  // a dedicated effect keyed on loadStatus runs AFTER React commits.
  useEffect(() => {
    if (loadStatus === "loaded" && noteId !== null) {
      textareaRef.current?.focus();
    }
  }, [loadStatus, noteId]);

  // Keep the freshest reindexing flag in a ref so the save callback (which
  // is memoized with [] deps for stable identity across renders) reads the
  // current value without rebinding the whole hook chain.
  const reindexingRef = useRef(reindexing);
  useEffect(() => {
    reindexingRef.current = reindexing;
  }, [reindexing]);

  // Phase 4 (D-06) — observe connectionStatus transitions and dispatch
  // saveStateMachine events accordingly.
  const prevConnectionStatusRef = useRef(connectionStatus);
  useEffect(() => {
    const prev = prevConnectionStatusRef.current;
    if (prev !== connectionStatus) {
      if (connectionStatus !== "connected") {
        dispatch({ type: "connectionLost" });
      } else if (prev !== "connected") {
        // Transition into connected (from connecting OR reconnecting).
        dispatch({ type: "connectionRestored" });
      }
      prevConnectionStatusRef.current = connectionStatus;
    }
  }, [connectionStatus]);

  // 2. Save the latest content. Implements coalescing per UI-SPEC.
  const performSave = useCallback(async (latestContent: string) => {
    // Phase 2 reindex guard: the parent will unmount the editor while the
    // overlay is up, but a debounced save fired moments before unmount can
    // still race through. Drop it.
    if (reindexingRef.current) return;
    const id = noteIdRef.current;
    if (id === null) return; // no note selected — guard
    // Phase 4 (D-06): skip autosave while WS is down or mid-reconnect.
    if (connectionStatusRef.current !== "connected") return;
    if (inFlight.current) {
      // Coalesce — mark exactly ONE trailing save; subsequent saves during the
      // same in-flight window overwrite this single slot (no save storm).
      trailingPending.current = true;
      return;
    }
    inFlight.current = true;
    dispatch({ type: "requestSave" });
    try {
      // Plan 03-22 (Gap R2-6) — Direction A: H1 → filename.
      //
      // If the H1 in the latest content differs from the most-recently-
      // persisted H1 AND we're not already inside a rename round-trip,
      // dispatch postNoteMove(id, parent + sanitized + ".md") BEFORE
      // updateNote. Putting the move first makes a collision abort the
      // sequence cleanly (no half-saved state where the file got renamed
      // but the content also got committed under the old path).
      //
      // Failure modes:
      //   - extractH1FromContent returns null (no H1 / empty H1) →
      //     no-op; fall through to updateNote.
      //   - sanitize fails (illegal chars / leading dot / empty) →
      //     soft error: surface a banner, skip the move, but STILL
      //     run updateNote so the user's typing is not lost.
      //   - postNoteMove returns error.code === "case_collision" →
      //     hard error: surface a different banner, BAIL OUT entirely
      //     (do NOT updateNote). Subsequent edits will retry once the
      //     user changes the H1.
      //   - postNoteMove returns any other error → bail out with a
      //     generic message; same retry semantics.
      const currentH1 = extractH1FromContent(latestContent);
      const h1Changed =
        currentH1 !== null && currentH1 !== lastH1Sent.current;

      if (h1Changed && !isRenameInProgress.current) {
        const sanitized = sanitizeH1ForFilename(currentH1);
        if (!sanitized.ok) {
          // Soft error — content save still proceeds.
          setH1RenameError(sanitized.error);
        } else {
          isRenameInProgress.current = true;
          try {
            const parent = parentDirOf(lastNotePath.current);
            const newPath = composeNewPath(
              parent,
              sanitized.value + ".md",
            );
            // CR-01 fix — compare against the server's canonical
            // (lowercase per DATA-11) form so a case-only H1 change
            // (e.g. "# my plan" → "# MY PLAN" on a file already named
            // "my plan.md") is recognised as a no-op instead of being
            // dispatched as a move that would 409 with case_collision.
            // This mirrors Plan 03-19's same-name short-circuit in
            // RenameInput; the H1-driven path needs the same guard.
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
              // Canonical path matches — record the H1 as persisted so
              // we don't re-detect it as changed on the next save. Skip
              // the dispatch (it would no-op or 409 server-side anyway).
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
      // Plan 03-23 — broadcast refresh so the FileTree re-fetches
      // GET /tree and the tree row label reflects the latest title.
      // Service.Update (post-Plan-03-23 fix) re-extracts the H1 on
      // every write; Service.Move (Plan 03-21) does the same. Either
      // way, the tree's title field is fresh after this Update — but
      // the FileTree only re-fetches when refresh() is called. Without
      // this, after a Direction A H1-edit the user sees the stale
      // label until the next reload (the false-positive surface that
      // Plan 03-23 Scenario G is designed to catch).
      if (h1Changed) {
        await refreshTree();
      }
      dispatch({
        type: "saveSucceeded",
        updatedAt: new Date(data.updated_at),
      });
      // Schedule the savedTimer → idle transition (sticky ~2s).
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
      // Fire the queued trailing save if one was requested during in-flight.
      if (trailingPending.current) {
        trailingPending.current = false;
        // Use the freshest content captured by the ref, not the closure
        // argument (which could be stale if many edits happened).
        void performSave(latestContentRef.current);
      }
    }
  }, [refreshTree]);

  // 3. Debounced autosave on edit.
  const onChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      // CR-04: latch the edited flag so a late-arriving GET cannot
      // overwrite the typed text. Set BEFORE the state writes so a
      // concurrent load-effect resolution observes it.
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
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [performSave],
  );

  // 4. Cmd+S / Ctrl+S immediate save (UI-SPEC §Save-trigger timing).
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const isSaveShortcut =
        (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s";
      if (!isSaveShortcut) return;
      e.preventDefault();
      // Collapse any pending debounce.
      if (debounceTimer.current !== null) {
        window.clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      void performSave(latestContentRef.current);
    },
    [performSave],
  );

  // 5. Cleanup timers on unmount.
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

  // Phase 4 (Plan 04-05) — WS event handlers.

  /**
   * D-10: when note:updated arrives for the OPEN note AND userHasEdited is false
   * AND no debounce/inflight pending, silently re-fetch and replace content;
   * cursor preserved.
   * D-11: when unsaved edits OR pending autosave OR in-flight save, surface the
   * conflict banner (SYNC-05) — never silent overwrite.
   */
  const onNoteUpdated = useCallback(
    (p: WSNoteUpdatedPayload) => {
      if (p.id !== noteIdRef.current) return; // not the open note
      const debouncePending = debounceTimer.current !== null;
      const inFlightSave = inFlight.current;
      if (!userHasEdited.current && !debouncePending && !inFlightSave) {
        // D-10: silent reload.
        void (async () => {
          try {
            const { data } = await getNote(p.id);
            if (!data) return;
            const ta = textareaRef.current;
            const prevStart = ta?.selectionStart ?? 0;
            const prevEnd = ta?.selectionEnd ?? 0;
            setContent(data.content);
            latestContentRef.current = data.content;
            // Restore cursor after React commits, clamped to new length.
            requestAnimationFrame(() => {
              if (!ta) return;
              ta.selectionStart = Math.min(prevStart, data.content.length);
              ta.selectionEnd = Math.min(prevEnd, data.content.length);
            });
          } catch {
            // Silent reload failed — surface conflict banner as fallback so
            // the user knows state is unclear.
            setConflictBanner({ visible: true, currentUpdatedAt: p.updated_at });
          }
        })();
        return;
      }
      // D-11: unsaved edits OR pending save → conflict banner.
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

  // Publish handlers to the ref so App.tsx's useSessionSync can dispatch
  // WS events into this editor without a new event-bus abstraction (D-09).
  useEffect(() => {
    if (editorHandlersRef) {
      editorHandlersRef.current = { onNoteUpdated, onNoteDeleted };
    }
    return () => {
      if (editorHandlersRef) {
        editorHandlersRef.current = null;
      }
    };
  }, [editorHandlersRef, onNoteUpdated, onNoteDeleted]);

  // Phase 3: null noteId → render placeholder, NOT the textarea. We
  // still mount the SaveIndicator so the surface chrome remains
  // identical to a populated editor, and so a future "you typed but
  // there's no active note" affordance can sit alongside it without
  // remounting the parent.
  if (noteId === null) {
    return (
      <section
        className="flex flex-col h-full bg-bg"
        data-testid="editor-pane-placeholder"
      >
        <SaveIndicator state={saveState} />
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
    <section className="flex flex-col h-full bg-bg">
      <SaveIndicator state={saveState} />
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
              // D-02: manual × dismiss — banner can re-appear on next event.
              // Save anyway: re-issue PUT with the server-supplied
              // current_updated_at as the new If-Match (T-04-06).
              // The server may still reject (a third writer raced) — in that
              // case we re-show the banner with the newer comparator.
              void (async () => {
                const result = await updateNote(
                  noteIdRef.current!,
                  latestContentRef.current,
                  conflictBanner.currentUpdatedAt,
                );
                if (result.error) {
                  const staleErr = result.error as {
                    code?: string;
                    current_updated_at?: string;
                  };
                  if (
                    staleErr.code === "stale_write" &&
                    staleErr.current_updated_at
                  ) {
                    // Re-show with the newer comparator.
                    setConflictBanner({
                      visible: true,
                      currentUpdatedAt: staleErr.current_updated_at,
                    });
                  }
                  return;
                }
                // Success — clear banner and reset edited flag.
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
              // Discard: re-fetch and replace content; clear banner;
              // mark not-edited so silent reloads work again.
              void (async () => {
                const id = noteIdRef.current;
                if (!id) return;
                const { data } = await getNote(id);
                if (data) {
                  setContent(data.content);
                  latestContentRef.current = data.content;
                  userHasEdited.current = false;
                }
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
      <textarea
        ref={textareaRef}
        className="flex-1 bg-bg text-fg font-mono p-4 outline-none resize-none border-0"
        style={{ fontSize: "15px", lineHeight: 1.6 }}
        value={loadStatus === "loaded" && !reindexing ? content : ""}
        placeholder={
          reindexing
            ? REINDEXING_PLACEHOLDER
            : loadStatus === "loading"
              ? "Loading…"
              : ""
        }
        onChange={onChange}
        onKeyDown={onKeyDown}
        disabled={loadStatus !== "loaded" || reindexing}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-label="Note content"
      />
    </section>
  );
}

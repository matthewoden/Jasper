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
import { dispatchTagEvent } from "../lib/useTagBrowser";
import {
  initialSaveState,
  saveStateReducer,
} from "../lib/saveStateMachine";
import { postNoteMove, type Tree, type TreeNode } from "../lib/treeApi";
import { useFileTree } from "../lib/useFileTree";
import { useTreeStore } from "../lib/useTreeStore";
import { SaveIndicator } from "./SaveIndicator";
import type { components } from "../api/schema";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor"; // Plan 05-11 D-26..D-27

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
  /**
   * UAT #4 fix: imperative open of CM6's search panel (same as Cmd+F
   * when the editor is focused). Called from App.tsx commandActions.onFind
   * so the "Find in note" command palette entry actually opens the panel.
   * Forwarded through MarkdownEditorRef.openFindPanel() via editorRef.
   * No-op when no editor is mounted (noteId === null or editor not yet ready).
   */
  openFindPanel: () => void;
}

// Locked timing constants (UI-SPEC §Save-trigger timing). Exported as named
// consts so the verification grep can prove they exist; Phase 5 reuses them.
export const AUTOSAVE_DEBOUNCE_MS = 2000;
export const SAVED_STICKY_MS = 2000;

const LOAD_ERROR_COPY =
  "Could not load note. Check that the server is running, then refresh the page.";

// Phase 2 (UI-SPEC §Surface 3 + §Layout Contract): when reindexing=true,
// App.tsx mounts the <ReindexProgress /> overlay in the editor pane's place
// during a real reindex; the reindexing prop is the in-component guard so save
// attempts that race the unmount cannot leak through (reindexingRef). Plan 05-11:
// the textarea's "Index is rebuilding…" placeholder is gone (no textarea);
// reindexing prevention is via reindexingRef.current check in performSave.

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
  /**
   * Phase 6.6 — Plan 06.6-11: optional style for grid placement.
   * App.tsx passes gridRow/gridColumn here; merged onto the root section.
   */
  style?: React.CSSProperties;
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
    switch (node.kind) {
      case "note":
        return node.id === noteId ? node.path : null;
      case "folder":
        // children is optional on FolderNode (openapi.yaml: "ONLY populated
        // when this FolderNode appears inside a Tree response"). Guard
        // before recursion.
        if (node.children) {
          for (const child of node.children) {
            const hit = visit(child);
            if (hit !== null) return hit;
          }
        }
        return null;
      case "file":
        // Plan 07-26: non-markdown files have no noteId; skip path lookup.
        return null;
      default: {
        // WR-04 (Phase 5.5 gap-closure Plan 12) — exhaustiveness guard.
        // A future TreeNode discriminant addition will fail this assignment
        // at compile time, surfacing the call site rather than silently
        // returning null.
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

export function EditorPane({ noteId, reindexing = false, editorHandlersRef, style }: EditorPaneProps) {
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

  // Plan 05-11 D-26: editorRef exposes the MarkdownEditor ref API:
  //   getContent()           reads the CM6 document (was textarea.value)
  //   setContent(s)          replaces doc + triggers onChange (user-driven)
  //   applyServerUpdate(s)   replaces doc WITHOUT onChange (server-driven, D-10)
  //   focus()                focuses the CM6 caret (was textarea.focus())
  const editorRef = useRef<MarkdownEditorRef>(null);
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

  // BL-04 (Phase 5.5 gap-closure Plan 12) — one-shot guard so the keepalive
  // PUT fires AT MOST ONCE per tab-close lifecycle. Both visibilitychange→hidden
  // AND beforeunload can fire on tab close (in that order); we want the first
  // one to land the bytes via keepalive, and the second to no-op rather than
  // double-PUT. Reset on visible→hidden→visible so a subsequent hide can
  // fire keepalive again.
  const keepaliveSentRef = useRef(false);

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

  // Plan 04 (UX-08) / RESEARCH §Pitfall 6 — track the PREVIOUS noteId so
  // the load effect can detect a switch and clear the stale live label.
  // Cannot read it from `noteIdRef` because the noteIdRef-update effect
  // (declared above) runs FIRST on a noteId change and overwrites the
  // previous value before this effect sees it. This dedicated ref is
  // updated at the END of the load effect, after the prev-id read.
  const prevNoteIdRef = useRef<string | null>(noteId);

  // 1. Load on mount AND whenever noteId changes (Phase 3).
  useEffect(() => {
    // Plan 04 (UX-08) / RESEARCH §Pitfall 6: clear stale live label for
    // the PREVIOUS note if the user switched away with unsaved edits
    // (no successful save flushed the canonical title to the wire tree).
    // Read prevNoteIdRef (NOT noteIdRef) because noteIdRef has already
    // been updated to the new noteId by the dedicated effect above.
    {
      const prevId = prevNoteIdRef.current;
      if (prevId !== null && prevId !== noteId && userHasEdited.current) {
        useTreeStore.getState().clearLiveLabel(prevId);
      }
      // Record the new "previous" for the NEXT switch.
      prevNoteIdRef.current = noteId;
    }
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
      // Only seed the editor + latest-content ref if the user hasn't
      // started typing. Without this guard a slow / double-mount GET
      // can overwrite typed bytes (CR-04).
      if (!userHasEdited.current) {
        setContent(data.content);
        latestContentRef.current = data.content;
        // Plan 05-11 D-26: MarkdownEditor is uncontrolled — feed the loaded
        // content via applyServerUpdate so the updateListener's onChange
        // is NOT triggered (preserves userHasEdited=false, CR-04).
        editorRef.current?.applyServerUpdate(data.content);
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

  // 1b. Focus the editor after the loaded state commits. Running this from
  // the load-effect's promise chain races the disabled→enabled re-render —
  // a dedicated effect keyed on loadStatus runs AFTER React commits.
  useEffect(() => {
    if (loadStatus === "loaded" && noteId !== null) {
      editorRef.current?.focus(); // Plan 05-11 D-26
    }
  }, [loadStatus, noteId]);

  // Keep the freshest reindexing flag in a ref so the save callback (which
  // is memoized with [] deps for stable identity across renders) reads the
  // current value without rebinding the whole hook chain.
  const reindexingRef = useRef(reindexing);
  useEffect(() => {
    reindexingRef.current = reindexing;
  }, [reindexing]);

  // Phase 4 (D-06) — connectionStatus transition tracker. The effect that
  // dispatches saveStateMachine events lives BELOW performSave because it
  // also calls performSave on connectionRestored (WR-02 gap-closure Plan
  // 12) — referencing performSave in a useEffect dep array before its
  // useCallback declaration would be a TDZ violation.
  const prevConnectionStatusRef = useRef(connectionStatus);

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
      // BUG-01 fix (Phase 6.5 Plan 08): the WS EventTagsUpdated broadcast uses
      // origin_session_id = this session, so the SYNC-03 filter in useSessionSync
      // suppresses it for the saving tab. Dispatch directly so the local
      // useTagBrowser subscriber refetches and the right-rail tag count updates
      // within one render cycle without waiting for a WS round-trip.
      dispatchTagEvent("tags:updated");
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

  // Phase 4 (D-06) — observe connectionStatus transitions and dispatch
  // saveStateMachine events accordingly.
  //
  // WR-02 (Phase 5.5 gap-closure Plan 12) — flush buffered edits made
  // while the WS was paused. performSave skips when not connected, so
  // edits typed during the disconnect never land until the user types
  // again post-reconnect; if the user closes the tab in between, those
  // bytes are lost. The connectionRestored event is the canonical moment
  // to retry the save.
  //
  // performSave's useCallback has [refreshTree] as its dep array, and
  // refreshTree is stable across re-renders (its useCallback has []
  // deps in useFileTree.ts). performSave's identity is therefore stable,
  // so the simple form (performSave in dep array) is correct: the effect
  // re-runs only on connectionStatus transitions.
  useEffect(() => {
    const prev = prevConnectionStatusRef.current;
    if (prev !== connectionStatus) {
      if (connectionStatus !== "connected") {
        dispatch({ type: "connectionLost" });
      } else if (prev !== "connected") {
        // Transition into connected (from connecting OR reconnecting).
        dispatch({ type: "connectionRestored" });
        // WR-02: flush the buffered edits the user typed while paused.
        // Gated on userHasEdited (so we don't issue a spurious round-trip
        // on a clean reconnect) AND on noteIdRef (so a reconnect with no
        // active note can't slip through).
        if (userHasEdited.current && noteIdRef.current !== null) {
          void performSave(latestContentRef.current);
        }
      }
      prevConnectionStatusRef.current = connectionStatus;
    }
  }, [connectionStatus, performSave]);

  // 3. Debounced autosave on edit — Plan 05-11 D-27/D-32: same logic as the
  // old textarea onChange but now receives the new doc string directly from
  // MarkdownEditor's onChange prop (no ChangeEvent.target.value extraction).
  const handleEditorChange = useCallback(
    (next: string) => {
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

  // 3b. H1-change callback — Plan 05-11 D-27 wired by Plan 04 (UX-08).
  // MarkdownEditor fires onH1Change on every user-typed change with the
  // current H1 or null. The persistence pipeline (Plan 03-22 H1↔filename
  // rename) still runs inside performSave on the debounced timer; this
  // callback is the live UI feedback path:
  //   - non-empty H1 → setLiveLabel(noteId, trimmed) so TreeRow renders
  //     the in-flight title in the sidebar pre-save (UX-08).
  //   - null / empty H1 → clearLiveLabel(noteId) so the row falls back to
  //     the canonical wire-tree title.
  // Cleared on note-switch with unsaved edits via the noteId-change load
  // effect above (Pitfall 6 mitigation).
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

  // 4. Cmd+S immediate save — Plan 05-11 EDIT-10: Cmd+S is now handled by
  // saveKeymap inside MarkdownEditor (jasperKeymap.ts). MarkdownEditor calls
  // the onSaveRequested prop, which resolves here. The old onKeyDown on the
  // textarea is DELETED — this callback replaces it.
  const handleSaveRequested = useCallback(() => {
    // Collapse any pending debounce.
    if (debounceTimer.current !== null) {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    void performSave(latestContentRef.current);
  }, [performSave]);

  // 4b. UX-07: editor blur (focus moved to sidebar / browser chrome / etc.).
  // handleEditorBlur collapses pending debounce + dispatches requestSave NOW.
  // Routes through performSave so paused / connectionStatus / inFlight /
  // trailingPending gating all flow through unchanged.
  const handleEditorBlur = useCallback(() => {
    // BUG-03 fix (Phase 6.5 Plan 08): suppress blur-triggered save when the
    // user has not typed anything since the note was opened. handleEditorBlur
    // fires when the editor's contenteditable loses focus — including on a
    // tree-row click that switches notes. Without this guard, every note
    // switch triggers a no-op save round-trip that dispatches saveSucceeded
    // and shows the "Saved" indicator falsely (RESEARCH §BUG-03; PATTERNS
    // §handleEditorBlur surface).
    // userHasEdited.current is reset to false on every note load (lines 316, 331)
    // and set to true only on the first keystroke (handleEditorChange line 577).
    if (!userHasEdited.current) return;
    if (debounceTimer.current !== null) {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    void performSave(latestContentRef.current);
  }, [performSave]);

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

  // 5b. UX-07 / BL-04: page-exit save (Phase 5.5 gap-closure Plan 12).
  //
  //   Updated precedence (post-Plan-12):
  //
  //  (1) visibilitychange→hidden — fire a `keepalive: true` raw fetch PUT.
  //      The previous `performSave(latestContentRef.current)` issued a
  //      non-keepalive PUT via the typed openapi-fetch wrapper; on real
  //      tab close the browser aborted it and the bytes never reached
  //      the server (BL-04). Keepalive survives unload.
  //  (2) beforeunload — secondary fallback. If visibilitychange already
  //      fired the keepalive PUT for this tab-close lifecycle, the
  //      one-shot keepaliveSentRef short-circuits this branch. Some
  //      browsers fire beforeunload without a prior visibilitychange
  //      (synchronous window.close from within the page); this branch
  //      covers them.
  //
  //  Pitfall 2 (RESEARCH §Pitfall 2): both events can fire on tab close
  //  (visibilitychange first, beforeunload second). The keepaliveSentRef
  //  one-shot dedups them so we issue exactly ONE keepalive PUT per
  //  tab-close lifecycle. visible→hidden→visible re-arms the ref so a
  //  subsequent hide can fire keepalive again.
  useEffect(() => {
    const onVisibilityChange = () => {
      // Reset the one-shot guard if the user re-shows the tab (visibilityState
      // flipped from hidden→visible). A subsequent hide should be allowed to
      // fire keepalive again.
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
      // Phase 4 paused gate — same condition performSave uses.
      if (connectionStatusRef.current !== "connected") return;
      if (keepaliveSentRef.current) return;
      keepaliveSentRef.current = true;
      // BL-04: keepalive: true survives tab close. The previous
      // performSave(latestContentRef.current) issued a non-keepalive PUT
      // via the typed openapi-fetch wrapper; on real tab close the browser
      // aborted it and the bytes never reached the server.
      void fetch(`/api/v1/notes/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: latestContentRef.current }),
        keepalive: true,
      });
    };
    const onBeforeUnload = () => {
      // Secondary fallback. If visibilitychange already fired the keepalive
      // PUT for this tab-close lifecycle, do nothing. Some browsers fire
      // beforeunload without a prior visibilitychange (e.g., synchronous
      // window.close from within the page); this branch covers them.
      if (keepaliveSentRef.current) return;
      const id = noteIdRef.current;
      if (id === null) return;
      if (connectionStatusRef.current !== "connected") return;
      keepaliveSentRef.current = true;
      void fetch(`/api/v1/notes/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
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
        // D-10: silent reload — Plan 05-11 D-27: applyServerUpdate dispatches
        // through MarkdownEditor's ServerUpdateAnnotation so the editor's
        // updateListener skips onChange (no autosave loop). Cursor is preserved
        // by CM6 (EditorView keeps its selection unless the doc change forces
        // an adjustment). No requestAnimationFrame cursor-restore needed.
        void (async () => {
          try {
            const { data } = await getNote(p.id);
            if (!data) return;
            setContent(data.content);
            latestContentRef.current = data.content;
            editorRef.current?.applyServerUpdate(data.content);
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
      editorHandlersRef.current = {
        onNoteUpdated,
        onNoteDeleted,
        // UAT #4 fix: forward openFindPanel through MarkdownEditorRef so App's
        // commandActions.onFind can open CM6's search panel imperatively.
        openFindPanel: () => {
          editorRef.current?.openFindPanel();
        },
      };
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
        style={style}
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
    <section
      className="flex flex-col h-full bg-bg"
      style={{ minHeight: 0, overflow: "hidden", position: "relative", ...style }}
    >
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
                // WR-05 (Phase 5.5 gap-closure Plan 12) — local id capture
                // replaces the previous noteIdRef.current! non-null
                // assertion. The banner only mounts when noteId !== null,
                // but the gap between the banner-mounted snapshot and the
                // user clicking Save-anyway is async; null-guarding here
                // avoids future regressions if the banner mount becomes
                // decoupled from the noteId guard.
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
                    // Re-show with the newer comparator. Clear any prior
                    // inline error from a previous non-stale failure so
                    // the user sees a clean banner this time.
                    setH1RenameError(null);
                    setConflictBanner({
                      visible: true,
                      currentUpdatedAt: staleErr.current_updated_at,
                    });
                    return;
                  }
                  // BL-03: every OTHER error (write_failed 500, network,
                  // 404, etc.) used to silently no-op — banner stayed
                  // open, save state machine never heard about the
                  // failure, SaveIndicator stuck on green-Saved. Surface
                  // both an inline error AND a saveFailed dispatch so
                  // the user has a clear path forward.
                  //
                  // WR-06 (Phase 5.5 gap-closure Plan 12) — non-stale
                  // error recovery. Previously the branch left the banner
                  // mounted with the ORIGINAL currentUpdatedAt, so a
                  // subsequent "Save anyway" click was guaranteed to be
                  // stale-rejected. Refresh the comparator from the
                  // server before surfacing the inline error so the user
                  // has a real path to retry.
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
                  // Leave the banner open — the user can retry (now with
                  // the refreshed comparator), dismiss via ×, or Discard.
                  return;
                }
                // Success — clear banner, inline error, and edited flag.
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
              // Discard: re-fetch and replace content; clear banner;
              // mark not-edited so silent reloads work again.
              //
              // BL-04: previously the error field of the openapi-fetch
              // tuple was destructured-ignored; on getNote failure
              // (404 concurrent delete, 500, network) the textarea was
              // NOT refreshed but the banner cleared anyway, leaving
              // the user with stale content and no warning indicator.
              // The handler also did not check note id at resolve
              // time, so a mid-fetch note switch could clobber the
              // newly-active note's content with the old one.
              void (async () => {
                const id = noteIdRef.current;
                if (!id) return;
                const { data, error } = await getNote(id);
                // User switched notes mid-fetch — drop result entirely;
                // do NOT clear banner (it belongs to the now-inactive
                // note's state, but the new note's load effect owns
                // its own banner).
                if (id !== noteIdRef.current) return;
                if (error || !data) {
                  // Surface a load-error inline; do NOT silently clear
                  // the conflict banner — content is still stale.
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
                // Plan 05-11 D-26: use applyServerUpdate for Discard so the
                // editor's onChange is NOT triggered (avoids autosave loop).
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
          // minHeight: 0 + overflow: hidden lets this column track its
          // parent's bounded height. Without minHeight: 0 a flex column's
          // children expand it to their intrinsic size; with that, the
          // CM6 .cm-scroller can take over and scroll long documents
          // internally instead of inflating the page.
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

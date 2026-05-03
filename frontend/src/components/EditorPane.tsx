/**
 * EditorPane — the Phase 1 editor: controlled <textarea> + load on mount +
 * 2s debounced autosave + Cmd+S immediate save + in-flight save coalescing,
 * all driving the locked SaveIndicator state machine (Task 1).
 *
 * Per 01-UI-SPEC.md §"Forward-looking constraint": Phase 5's CodeMirror swap
 * replaces ONLY the <textarea> element. The autosave debounce, Cmd+S handler,
 * coalescing logic, and SaveIndicator remain unchanged. That is why every
 * piece of save logic lives in this component (or in pure modules under
 * lib/) — none of it is coupled to the textarea DOM API.
 */

import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  ScratchpadUUID,
  getNote,
  updateNote,
} from "../lib/notesApi";
import {
  initialSaveState,
  saveStateReducer,
} from "../lib/saveStateMachine";
import { SaveIndicator } from "./SaveIndicator";

type LoadStatus = "loading" | "loaded" | "error";

// Locked timing constants (UI-SPEC §Save-trigger timing). Exported as named
// consts so the verification grep can prove they exist; Phase 5 reuses them.
export const AUTOSAVE_DEBOUNCE_MS = 2000;
export const SAVED_STICKY_MS = 2000;

const LOAD_ERROR_COPY =
  "Could not load scratchpad. Check that the server is running, then refresh the page.";

// Phase 2 (UI-SPEC §Surface 3 + §Layout Contract): when reindexing=true the
// textarea disables and shows this placeholder. App.tsx mounts the
// <ReindexProgress /> overlay in the editor pane's place during a real
// reindex; this prop is the in-component guard so save attempts that race
// the unmount cannot leak through.
const REINDEXING_PLACEHOLDER = "Index is rebuilding…";

interface EditorPaneProps {
  reindexing?: boolean;
}

export function EditorPane({ reindexing = false }: EditorPaneProps = {}) {
  const [content, setContent] = useState("");
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [saveState, dispatch] = useReducer(
    saveStateReducer,
    initialSaveState,
  );

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
  // CR-04: tracks whether the user has typed since mount. The load
  // effect only seeds latestContentRef before any typing — under React
  // 19 StrictMode the load effect runs twice, and a stale GET resolving
  // after the user starts typing would otherwise clobber the typed text
  // and the next debounced save would persist the loaded content as if
  // the typed bytes never happened (silent data loss).
  const userHasEdited = useRef(false);

  // 1. Load on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await getNote(ScratchpadUUID);
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
      setLoadStatus("loaded");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 1b. Focus the textarea after the enabled state commits. Running this from
  // the load-effect's promise chain races the disabled→enabled re-render —
  // a dedicated effect keyed on loadStatus runs AFTER React commits.
  useEffect(() => {
    if (loadStatus === "loaded") {
      textareaRef.current?.focus();
    }
  }, [loadStatus]);

  // Keep the freshest reindexing flag in a ref so the save callback (which
  // is memoized with [] deps for stable identity across renders) reads the
  // current value without rebinding the whole hook chain.
  const reindexingRef = useRef(reindexing);
  useEffect(() => {
    reindexingRef.current = reindexing;
  }, [reindexing]);

  // 2. Save the latest content. Implements coalescing per UI-SPEC.
  const performSave = useCallback(async (latestContent: string) => {
    // Phase 2 reindex guard: the parent will unmount the editor while the
    // overlay is up, but a debounced save fired moments before unmount can
    // still race through. Drop it.
    if (reindexingRef.current) return;
    if (inFlight.current) {
      // Coalesce — mark exactly ONE trailing save; subsequent saves during the
      // same in-flight window overwrite this single slot (no save storm).
      trailingPending.current = true;
      return;
    }
    inFlight.current = true;
    dispatch({ type: "requestSave" });
    try {
      const { data, error } = await updateNote(
        ScratchpadUUID,
        latestContent,
      );
      if (error || !data) {
        const msg =
          (error as { message?: string } | undefined)?.message ??
          "save failed";
        dispatch({ type: "saveFailed", error: msg });
        return;
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
  }, []);

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

  return (
    <section className="flex flex-col h-full bg-bg">
      <SaveIndicator state={saveState} />
      {loadStatus === "error" && (
        <div className="px-4 text-destructive" role="alert">
          {LOAD_ERROR_COPY}
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
        aria-label="Scratchpad note content"
      />
    </section>
  );
}

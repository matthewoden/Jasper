/**
 * noteBufferController — one per note, owning content, save state, debounce,
 * coalesced flush and WS reconciliation.
 *
 * Before this existed each pane held its own copy, so two panes on one note ran
 * competing debounce/save cycles and reconciled the same note:updated event
 * independently (WS-10). getOrCreateController guarantees one of each per note.
 *
 * Deliberately React-free so it can be driven from an effect, a WS dispatch
 * loop, or a bare unit test. Bridge it with useSyncExternalStore.
 */

import { extractH1FromContent, sanitizeH1ForFilename } from "./h1Extract";
import { getNoteFresh, staleWriteComparator, updateNote } from "./notesApi";
import { postNoteMove } from "./treeApi";
import { publish } from "./resources";
import {
  initialSaveState,
  saveStateReducer,
  type SaveEvent,
  type SaveState,
} from "./saveStateMachine";
import type { components } from "../api/schema";

type WSNoteUpdatedPayload = components["schemas"]["WSNoteUpdatedPayload"];
type WSNoteDeletedPayload = components["schemas"]["WSNoteDeletedPayload"];

export const AUTOSAVE_DEBOUNCE_MS = 2000;
export const SAVED_STICKY_MS = 2000;

export interface ConflictState {
  visible: boolean;
  currentUpdatedAt: string;
}

export interface DeletedState {
  visible: boolean;
  deletedPath: string;
}

/**
 * Per-note buffer controller. One instance exists per open noteId
 * (see getOrCreateController) for the entire time that note is open in
 * ANY pane.
 */
export interface NoteBufferController {
  getSaveState(): SaveState;
  getContent(): string;
  getConflict(): ConflictState | null;
  getDeleted(): DeletedState | null;
  getH1RenameError(): string | null;
  /**
   * The note's current path (relative), as seeded by hydrate()'s server load
   * and kept fresh by setNotePath() on rename/move. This is the pane-local,
   * active-state-independent source for the breadcrumb + word-count metadata
   * bar: it is available the moment the note loads (same getNote() as the
   * content), so the metadata bar never waits on — or diverges with — the
   * separate per-pane useFileTree() fetch. Returns "" before the first load.
   */
  getNotePath(): string;
  /**
   * The note's etag as of the last server response this controller saw — the
   * If-Match every save sends. Null only before the first hydrate, which is the
   * one window in which a save is permissive.
   */
  getETag(): string | null;
  /**
   * Seeds content/path/etag from a server load (EditorPane's initial getNote,
   * or the conflict banner's Discard re-fetch). etag is required: a load that
   * forgot it would silently leave the previous note's comparator in place.
   */
  hydrate(serverContent: string, path: string, etag: string): void;
  /** External-store style subscription — notified on any save-state transition. */
  subscribe(fn: (s: SaveState) => void): () => void;
  /**
   * Fired once, synchronously, right after a save successfully renames the
   * note on disk (H1-driven move). WS `note:moved` broadcasts exclude the
   * originating session (SYNC-03), so the pane that JUST caused the rename
   * would otherwise never see its own tree entry update; EditorPane uses this
   * to trigger its own refreshTree().
   */
  subscribeRenamed(fn: (newPath: string) => void): () => void;
  /**
   * Fires when onNoteUpdated silently adopts server content. MarkdownEditor is
   * uncontrolled — CM6 only shows a new document via applyServerUpdate, never
   * by reacting to a prop — so the call site must push it in.
   *
   * NOT fired for hydrate or edits: those already call applyServerUpdate in the
   * same synchronous block.
   */
  subscribeContentReplaced(fn: (content: string) => void): () => void;
  handleEditorChange(next: string): void;
  /** Cancels the pending debounce and saves synchronously; rejects on failure (TAB-13). */
  flush(): Promise<void>;
  /** Fired once per noteId, regardless of how many panes have this note open. */
  onNoteUpdated(p: WSNoteUpdatedPayload): void;
  onNoteDeleted(p: WSNoteDeletedPayload): void;
  /**
   * One choke point for every save attempt — debounced, flushed or
   * reconnect-triggered. Returning false is a silent, state-unchanged no-op.
   *
   * Multi-owner by design: each pane registers its OWN gate and a save needs
   * ALL of them. The returned unregister removes only that caller's. A
   * single-slot setter would let one pane's unmount null out the shared gate
   * and silently bypass the guard for the survivors.
   */
  setSaveGate(gate: () => boolean): () => void;
  /**
   * Cancels any pending debounced save WITHOUT saving it — used when a pane
   * with no tab (the noteId-prop-driven fallback pane) switches to a
   * different note out from under this controller, mirroring the old
   * per-pane "debounce armed for the previous note must never fire" guard
   * (no cross-note PUT). Does not touch content/history; a later
   * hydrate() for the same noteId still fully resets state.
   */
  discardPendingEdit(): void;
  /**
   * Updates the debounce interval used by the NEXT armed debounce
   * (EditorPane's autosaveMs prop can arrive after mount, once the
   * async /config fetch resolves — getOrCreateController only honors its
   * autosaveMs argument on first construction, so a later change must be
   * pushed in explicitly rather than re-passed to getOrCreateController).
   */
  setAutosaveMs(ms: number): void;
  /**
   * Applies a save-state transition WITHOUT attempting a network save —
   * for the one UI flow (EditorPane's conflict-banner "Save anyway" button)
   * that intentionally calls updateNote directly (with an explicit If-Match
   * override) rather than through this controller's own performSave, but
   * still needs the shared saveState machine to reflect a failure.
   */
  reportSaveFailed(error: string): void;
  /**
   * Adopts an etag obtained outside performSave — the "Save anyway" button's
   * direct updateNote call. Without it the controller keeps sending the
   * comparator that button just superseded, and every subsequent autosave
   * 409s against the write the user explicitly authorized.
   */
  setETag(etag: string): void;
  /**
   * Drives the connectionLost/connectionRestored save-state transitions from
   * the pane's WS connectionStatus watcher. The pre-25-05 EditorPane
   * dispatched connectionLost directly; the controller-bridging refactor
   * dropped it, leaving SaveIndicator's "paused" state unreachable on
   * disconnect (260721-suite cluster A finding).
   */
  reportConnectionChange(connected: boolean): void;
  /**
   * Raw setters for the EditorPane conflict-banner "Save anyway"/"Discard"/
   * dismiss UI flow, which intentionally drives updateNote/getNote directly
   * (an explicit If-Match override, and a manual re-fetch) rather than
   * through this controller's own performSave/hydrate — the flow still
   * needs to update the SAME shared conflict/deleted/h1RenameError state so
   * every pane showing this note sees the resolution consistently.
   */
  setConflict(c: ConflictState | null): void;
  setDeleted(d: DeletedState | null): void;
  setH1RenameError(msg: string | null): void;
  /**
   * Re-seeds the H1-rename comparator's path without touching content or save
   * state. Needed when the note moved server-side between this pane's initial
   * GET and the next H1 edit — the comparator must compose against the note's
   * real current parent, not a stale load-time snapshot.
   */
  setNotePath(path: string): void;
}

function parentDirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function composeNewPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

class NoteBufferControllerImpl implements NoteBufferController {
  private readonly noteId: string;
  private autosaveMs: number;

  private content = "";
  private saveState: SaveState = initialSaveState;
  private conflict: ConflictState | null = null;
  private deleted: DeletedState | null = null;
  private h1RenameError: string | null = null;

  private readonly listeners = new Set<(s: SaveState) => void>();
  private readonly renameListeners = new Set<(newPath: string) => void>();
  private readonly contentReplacedListeners = new Set<(content: string) => void>();

  private debounceTimer: number | null = null;
  private savedTimer: number | null = null;
  private inFlight = false;
  private trailingPending = false;
  private trailingWaiters: Array<(r: { ok: boolean }) => void> = [];
  private userHasEdited = false;
  private isRenameInProgress = false;
  private lastH1Sent: string | null = null;
  private lastNotePath = "";
  /**
   * The comparator every save sends. Null before the first hydrate only.
   *
   * Conflict detection used to depend entirely on WebSocket delivery — the
   * exact channel that fails in the conflict scenario. A tab whose socket
   * dropped reconnects holding stale edits and flushes them before any event
   * can arrive, and events during the gap are gone. This token is what makes
   * the server reject that write instead of silently applying it.
   */
  private lastKnownETag: string | null = null;
  /** Multi-owner gate set — see setSaveGate's interface doc. */
  private readonly saveGates = new Set<() => boolean>();

  /** Set true by releaseController; aborts any in-flight trailing chain. */
  private released = false;

  constructor(noteId: string, autosaveMs: number) {
    this.noteId = noteId;
    this.autosaveMs = autosaveMs;
  }

  getSaveState(): SaveState {
    return this.saveState;
  }

  getContent(): string {
    return this.content;
  }

  getConflict(): ConflictState | null {
    return this.conflict;
  }

  getDeleted(): DeletedState | null {
    return this.deleted;
  }

  getH1RenameError(): string | null {
    return this.h1RenameError;
  }

  getNotePath(): string {
    return this.lastNotePath;
  }

  getETag(): string | null {
    return this.lastKnownETag;
  }

  setETag(etag: string): void {
    this.lastKnownETag = etag;
  }

  hydrate(serverContent: string, path: string, etag: string): void {
    this.content = serverContent;
    this.lastNotePath = path;
    this.lastKnownETag = etag;
    this.lastH1Sent = extractH1FromContent(serverContent);
    this.userHasEdited = false;
    this.conflict = null;
    this.deleted = null;
    this.h1RenameError = null;
    this.notify();
  }

  subscribe(fn: (s: SaveState) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  subscribeRenamed(fn: (newPath: string) => void): () => void {
    this.renameListeners.add(fn);
    return () => {
      this.renameListeners.delete(fn);
    };
  }

  subscribeContentReplaced(fn: (content: string) => void): () => void {
    this.contentReplacedListeners.add(fn);
    return () => {
      this.contentReplacedListeners.delete(fn);
    };
  }

  handleEditorChange(next: string): void {
    // Idempotent overwrite guard: a stray mirrored double-fire from the CM6
    // sync path (identical content delivered twice) must never re-arm the
    // debounce or produce a second save.
    if (next === this.content) return;
    this.userHasEdited = true;
    this.content = next;
    this.setSaveState({ type: "edit" });
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.performSave(this.content);
    }, this.autosaveMs);
  }

  async flush(): Promise<void> {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!this.userHasEdited) return;
    const { ok } = await this.performSave(this.content);
    if (!ok) throw new Error("flush failed");
  }

  onNoteUpdated(p: WSNoteUpdatedPayload): void {
    if (p.id !== this.noteId) return;
    const debouncePending = this.debounceTimer !== null;
    const inFlightSave = this.inFlight;
    if (!this.userHasEdited && !debouncePending && !inFlightSave) {
      void (async () => {
        try {
          const { data, error } = await getNoteFresh(p.id);
          if (this.released) return;
          if (error || !data) {
            this.setConflict({ visible: true, currentUpdatedAt: p.updated_at });
            return;
          }
          this.content = data.content;
          this.lastKnownETag = data.etag;
          // Re-seed the H1-rename comparator (and
          // the rename-comparator's path) from the JUST-adopted server
          // content. Without this, lastH1Sent/lastNotePath keep pointing at
          // this controller's stale pre-adopt values, so the next unrelated
          // edit's performSave() sees a spurious currentH1 !== lastH1Sent
          // mismatch and fires an unwanted postNoteMove against a path
          // another session may have already renamed (409/case_collision).
          this.lastH1Sent = extractH1FromContent(data.content);
          if (data.path) this.lastNotePath = data.path;
          this.notify();
          for (const fn of Array.from(this.contentReplacedListeners)) {
            fn(this.content);
          }
        } catch {
          if (this.released) return;
          this.setConflict({ visible: true, currentUpdatedAt: p.updated_at });
        }
      })();
      return;
    }
    this.setConflict({ visible: true, currentUpdatedAt: p.updated_at });
  }

  onNoteDeleted(p: WSNoteDeletedPayload): void {
    if (p.id !== this.noteId) return;
    this.deleted = { visible: true, deletedPath: p.path };
    this.notify();
  }

  /** Called by releaseController after the final flush; internal only. */
  markReleased(): void {
    this.released = true;
  }

  setSaveGate(gate: () => boolean): () => void {
    this.saveGates.add(gate);
    return () => {
      this.saveGates.delete(gate);
    };
  }

  discardPendingEdit(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.userHasEdited = false;
  }

  setAutosaveMs(ms: number): void {
    this.autosaveMs = ms;
  }

  reportSaveFailed(error: string): void {
    this.setSaveState({ type: "saveFailed", error });
  }

  reportConnectionChange(connected: boolean): void {
    this.setSaveState({
      type: connected ? "connectionRestored" : "connectionLost",
    });
  }

  setConflict(c: ConflictState | null): void {
    this.conflict = c;
    this.notify();
  }

  setDeleted(d: DeletedState | null): void {
    this.deleted = d;
    this.notify();
  }

  setH1RenameError(msg: string | null): void {
    this.h1RenameError = msg;
    this.notify();
  }

  setNotePath(path: string): void {
    if (path === this.lastNotePath) return;
    this.lastNotePath = path;
    // Notify so the breadcrumb re-renders when the live tree reports a fresher
    // path (rename/move) — getNotePath() is a subscribed snapshot in EditorPane.
    this.notify();
  }

  private setSaveState(event: SaveEvent): void {
    this.saveState = saveStateReducer(this.saveState, event);
    this.notify();
  }

  private notify(): void {
    const snapshot = this.saveState;
    for (const fn of Array.from(this.listeners)) {
      fn(snapshot);
    }
  }

  private async performSave(latestContent: string): Promise<{ ok: boolean }> {
    // Gate check FIRST, before any state transition or inFlight coalescing —
    // matches the pre-Plan-04 EditorPane.performSave ordering exactly: a
    // blocked attempt (reindexing/disconnected) leaves saveState untouched
    // and is never queued as a trailing save. ALL registered gates
    // (one per pane showing this note) must pass.
    for (const gate of this.saveGates) {
      if (!gate()) return { ok: false };
    }
    if (this.inFlight) {
      // A save is already running; this content rides out as the trailing
      // save. Resolve with ITS real outcome once it settles — never
      // optimistically here.
      this.trailingPending = true;
      return new Promise<{ ok: boolean }>((resolve) => {
        this.trailingWaiters.push(resolve);
      });
    }
    this.inFlight = true;
    this.setSaveState({ type: "requestSave" });
    try {
      const currentH1 = extractH1FromContent(latestContent);
      const h1Changed = currentH1 !== null && currentH1 !== this.lastH1Sent;

      if (h1Changed && !this.isRenameInProgress) {
        const sanitized = sanitizeH1ForFilename(currentH1);
        if (!sanitized.ok) {
          this.h1RenameError = sanitized.error;
        } else {
          this.isRenameInProgress = true;
          try {
            const parent = parentDirOf(this.lastNotePath);
            const newPath = composeNewPath(parent, sanitized.value + ".md");
            if (newPath.toLowerCase() !== this.lastNotePath.toLowerCase()) {
              const moveResp = await postNoteMove(this.noteId, newPath);
              if (moveResp.error) {
                const msg =
                  moveResp.error.code === "case_collision"
                    ? "Couldn't rename to match the heading — that filename is already taken."
                    : "Couldn't rename to match the heading. Try a different heading.";
                this.h1RenameError = msg;
                this.setSaveState({ type: "saveFailed", error: msg });
                return { ok: false };
              }
              // The comparator deliberately survives the move: a rename is an
              // os.Rename, which leaves mtime untouched, so the token this
              // controller already holds is still the note's current version.
              if (moveResp.data) {
                this.lastNotePath = moveResp.data.path;
                for (const fn of Array.from(this.renameListeners)) {
                  fn(moveResp.data.path);
                }
              }
              this.lastH1Sent = currentH1;
              this.h1RenameError = null;
            } else {
              this.lastH1Sent = currentH1;
              this.h1RenameError = null;
            }
          } finally {
            this.isRenameInProgress = false;
          }
        }
      }

      const { data, error } = await updateNote(
        this.noteId,
        latestContent,
        this.lastKnownETag ?? undefined,
      );
      if (error || !data) {
        // The 409 path the optimistic-locking machinery was built for. Every
        // piece of it already existed — the StaleWriteError schema, the banner,
        // the server comparator — and none of it could fire while this call
        // sent no If-Match.
        const currentUpdatedAt = staleWriteComparator(error);
        if (currentUpdatedAt !== null) {
          this.setConflict({ visible: true, currentUpdatedAt });
        }
        const msg =
          (error as { message?: string } | undefined)?.message ?? "save failed";
        this.setSaveState({ type: "saveFailed", error: msg });
        return { ok: false };
      }
      this.lastKnownETag = data.etag;
      this.setSaveState({
        type: "saveSucceeded",
        updatedAt: new Date(data.updated_at),
      });
      // The buffer now matches the server, so
      // clear the dirty flag. Without this, userHasEdited stayed true for
      // the life of the buffer after the FIRST edit ever made, which (a)
      // made onNoteUpdated's silent-adopt guard permanently false — every
      // later WS update from another session raised a spurious conflict
      // banner — and (b) made flush() re-PUT on every blur/tab-close/
      // reconnect even when nothing had changed since the last save. A
      // later keystroke re-sets this via handleEditorChange, same as today.
      this.userHasEdited = false;
      publish("tags:updated");
      if (this.savedTimer !== null) {
        window.clearTimeout(this.savedTimer);
      }
      this.savedTimer = window.setTimeout(() => {
        this.setSaveState({ type: "savedTimerExpired" });
      }, SAVED_STICKY_MS);
      return { ok: true };
    } catch (e) {
      this.setSaveState({
        type: "saveFailed",
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false };
    } finally {
      this.inFlight = false;
      if (this.trailingPending) {
        this.trailingPending = false;
        // Snapshot-and-clear so callers that coalesce onto the NEW trailing
        // save (fired below) queue onto a fresh array, not this one.
        const waiters = this.trailingWaiters;
        this.trailingWaiters = [];
        if (this.released) {
          // Controller was released while a save was in flight — never
          // write potentially-orphaned content after teardown started.
          waiters.forEach((resolve) => resolve({ ok: false }));
        } else {
          void this.performSave(this.content).then((r) => {
            waiters.forEach((resolve) => resolve(r));
          });
        }
      }
    }
  }
}

const controllers = new Map<string, NoteBufferControllerImpl>();

/** Lazily creates (or returns the existing) singleton controller for noteId. */
export function getOrCreateController(
  noteId: string,
  autosaveMs?: number,
): NoteBufferController {
  let existing = controllers.get(noteId);
  if (!existing) {
    existing = new NoteBufferControllerImpl(noteId, autosaveMs ?? AUTOSAVE_DEBOUNCE_MS);
    controllers.set(noteId, existing);
  }
  return existing;
}

/** Flushes pending edits then tears down the controller for noteId. */
export async function releaseController(noteId: string): Promise<void> {
  const existing = controllers.get(noteId);
  if (!existing) return;
  try {
    await existing.flush();
  } catch {
    // Best-effort — flush failures are already surfaced via saveState;
    // release proceeds regardless so the map never leaks stale entries.
  }
  controllers.delete(noteId);
  existing.markReleased();
}

/** Test-only escape hatch to reset module state between test files. */
export function __resetAllControllersForTest(): void {
  controllers.clear();
}

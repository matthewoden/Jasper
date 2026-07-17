/**
 * noteBufferController — per-note module singleton owning content, save
 * state, debounce, coalesced flush, and WebSocket reconciliation.
 *
 * Lifted out of EditorPane (D-01/D-03): before this module existed, every
 * mounted pane showing the same note owned its OWN copy of this state, so
 * two panes on one note could each run their own debounce/save cycle and
 * each reconcile the same note:updated event independently — a structural
 * divergence risk (WS-10). getOrCreateController(noteId) now guarantees
 * exactly one debounce timer, one save-state machine, and one WS
 * reconciliation path per open note, no matter how many panes show it.
 *
 * This module is intentionally React-free (no hooks, no component state) so
 * it can be driven from anywhere — a pane's effect, a WS dispatch loop, or a
 * unit test — without a React tree mounted. Consumers (EditorPane, Plan 05)
 * are expected to bridge this via subscribe()/getSaveState() through
 * something like useSyncExternalStore.
 */

import { extractH1FromContent, sanitizeH1ForFilename } from "./h1Extract";
import { getNote, updateNote } from "./notesApi";
import { postNoteMove } from "./treeApi";
import { dispatchTagEvent } from "./useTagBrowser";
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
  /** Seeds content/path from the server load path (EditorPane's initial getNote). */
  hydrate(serverContent: string, path: string): void;
  /** External-store style subscription — notified on any save-state transition. */
  subscribe(fn: (s: SaveState) => void): () => void;
  handleEditorChange(next: string): void;
  /** Cancels the pending debounce and saves synchronously; rejects on failure (TAB-13). */
  flush(): Promise<void>;
  /** Fired once per noteId, regardless of how many panes have this note open. */
  onNoteUpdated(p: WSNoteUpdatedPayload): void;
  onNoteDeleted(p: WSNoteDeletedPayload): void;
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
  private readonly autosaveMs: number;

  private content = "";
  private saveState: SaveState = initialSaveState;
  private conflict: ConflictState | null = null;
  private deleted: DeletedState | null = null;
  private h1RenameError: string | null = null;

  private readonly listeners = new Set<(s: SaveState) => void>();

  private debounceTimer: number | null = null;
  private savedTimer: number | null = null;
  private inFlight = false;
  private trailingPending = false;
  private trailingWaiters: Array<(r: { ok: boolean }) => void> = [];
  private userHasEdited = false;
  private isRenameInProgress = false;
  private lastH1Sent: string | null = null;
  private lastNotePath = "";

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

  hydrate(serverContent: string, path: string): void {
    this.content = serverContent;
    this.lastNotePath = path;
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
          const { data, error } = await getNote(p.id);
          if (this.released) return;
          if (error || !data) {
            this.setConflict({ visible: true, currentUpdatedAt: p.updated_at });
            return;
          }
          this.content = data.content;
          this.notify();
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

  private setConflict(c: ConflictState): void {
    this.conflict = c;
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
    if (this.inFlight) {
      // A save is already running; this content rides out as the trailing
      // save. Resolve with ITS real outcome once it settles (UAT-3) — never
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
              if (moveResp.data) {
                this.lastNotePath = moveResp.data.path;
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

      const { data, error } = await updateNote(this.noteId, latestContent);
      if (error || !data) {
        const msg =
          (error as { message?: string } | undefined)?.message ?? "save failed";
        this.setSaveState({ type: "saveFailed", error: msg });
        return { ok: false };
      }
      this.setSaveState({
        type: "saveSucceeded",
        updatedAt: new Date(data.updated_at),
      });
      dispatchTagEvent("tags:updated");
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

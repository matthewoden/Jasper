/**
 * Save state machine — locked by 01-UI-SPEC.md §"Save Indicator State Machine".
 *
 * Reused VERBATIM by Phase 5 when CodeMirror replaces the textarea (per the
 * UI-SPEC "Forward-looking constraint"). Keep this file pure (no React deps)
 * so the Phase 5 editor can drive it from a CM6 transaction filter.
 *
 * Transitions:
 *   idle      --requestSave-------> saving
 *   error     --requestSave-------> saving   (recovery path)
 *   saved     --requestSave-------> saving   (immediate Cmd+S during sticky)
 *   saving    --saveSucceeded----->  saved
 *   saving    --saveFailed-------->  error
 *   saved     --savedTimerExpired->  idle
 *   <any>     --edit--------------> <unchanged>  (debounce lives in component)
 */

export type SaveState =
  | { status: "idle" }
  | { status: "saving"; startedAt: Date }
  | { status: "saved"; savedAt: Date }
  | { status: "error"; error: string };

export type SaveEvent =
  | { type: "edit" }
  | { type: "requestSave" }
  | { type: "saveSucceeded"; updatedAt: Date }
  | { type: "saveFailed"; error: string }
  | { type: "savedTimerExpired" };

export const initialSaveState: SaveState = { status: "idle" };

export function saveStateReducer(
  state: SaveState,
  event: SaveEvent,
): SaveState {
  switch (event.type) {
    case "edit":
      // Pure typing does not transition; the component's debounce dispatches
      // requestSave when the 2s timer fires (or Cmd+S fires immediately).
      return state;
    case "requestSave":
      return { status: "saving", startedAt: new Date() };
    case "saveSucceeded":
      return { status: "saved", savedAt: event.updatedAt };
    case "saveFailed":
      return { status: "error", error: event.error };
    case "savedTimerExpired":
      // Only transition out of saved → idle; ignore stale timer firings if
      // we've already moved on (e.g. user typed during the sticky window and
      // we're already saving again).
      return state.status === "saved" ? { status: "idle" } : state;
    default:
      // Exhaustiveness — TypeScript narrows `event` to `never` here. We do
      // NOT bind it to a local (`noUnusedLocals` would flag that); the
      // type system gives us the check at compile time.
      return state;
  }
}

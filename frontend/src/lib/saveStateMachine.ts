/**
 * Save state machine — pure (no React deps) so the CM6 editor can drive it
 * from a transaction filter.
 *
 * Transitions:
 *   idle      --requestSave-------> saving
 *   error     --requestSave-------> saving   (recovery path)
 *   saved     --requestSave-------> saving   (immediate Cmd+S during sticky)
 *   saving    --saveSucceeded----->  saved
 *   saving    --saveFailed-------->  error
 *   saved     --savedTimerExpired->  idle
 *   <any>     --edit--------------> <unchanged>  (debounce lives in component)
 *   <any>     --connectionLost----> paused
 *   paused    --connectionRestored-> idle
 */

export type SaveState =
  | { status: "idle" }
  | { status: "saving"; startedAt: Date }
  | { status: "saved"; savedAt: Date }
  | { status: "error"; error: string }
  | { status: "paused" };

export type SaveEvent =
  | { type: "edit" }
  | { type: "requestSave" }
  | { type: "saveSucceeded"; updatedAt: Date }
  | { type: "saveFailed"; error: string }
  | { type: "savedTimerExpired" }
  | { type: "connectionLost" }
  | { type: "connectionRestored" };

export const initialSaveState: SaveState = { status: "idle" };

export function saveStateReducer(
  state: SaveState,
  event: SaveEvent,
): SaveState {
  switch (event.type) {
    case "edit":
      return state;
    case "requestSave":
      return { status: "saving", startedAt: new Date() };
    case "saveSucceeded":
      return { status: "saved", savedAt: event.updatedAt };
    case "saveFailed":
      return { status: "error", error: event.error };
    case "savedTimerExpired":
      return state.status === "saved" ? { status: "idle" } : state;
    case "connectionLost":
      return { status: "paused" };
    case "connectionRestored":
      return state.status === "paused" ? { status: "idle" } : state;
    default:
      return state;
  }
}

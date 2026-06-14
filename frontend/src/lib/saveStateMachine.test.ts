/**
 * Reducer tests for the save-state machine.
 * Covers every transition in saveStateReducer.
 */
import { describe, expect, it } from "vitest";

import {
  initialSaveState,
  saveStateReducer,
  type SaveState,
} from "./saveStateMachine";

describe("saveStateReducer", () => {
  it("R1: edit alone does not transition (debounce lives in the component)", () => {
    const next = saveStateReducer(initialSaveState, { type: "edit" });
    expect(next).toEqual({ status: "idle" });
  });

  it("R2: idle + requestSave → saving with startedAt timestamp", () => {
    const before = Date.now();
    const next = saveStateReducer(initialSaveState, { type: "requestSave" });
    const after = Date.now();
    expect(next.status).toBe("saving");
    if (next.status === "saving") {
      expect(next.startedAt).toBeInstanceOf(Date);
      expect(next.startedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(next.startedAt.getTime()).toBeLessThanOrEqual(after);
    }
  });

  it("R3: saving + saveSucceeded → saved with the supplied updatedAt", () => {
    const saving: SaveState = { status: "saving", startedAt: new Date(0) };
    const updatedAt = new Date(2025, 0, 1, 14, 30, 5);
    const next = saveStateReducer(saving, {
      type: "saveSucceeded",
      updatedAt,
    });
    expect(next).toEqual({ status: "saved", savedAt: updatedAt });
  });

  it("R4: saved + savedTimerExpired → idle", () => {
    const saved: SaveState = { status: "saved", savedAt: new Date() };
    const next = saveStateReducer(saved, { type: "savedTimerExpired" });
    expect(next).toEqual({ status: "idle" });
  });

  it("R5: saving + saveFailed → error with the supplied message", () => {
    const saving: SaveState = { status: "saving", startedAt: new Date(0) };
    const next = saveStateReducer(saving, {
      type: "saveFailed",
      error: "network",
    });
    expect(next).toEqual({ status: "error", error: "network" });
  });

  it("R6: error + requestSave → saving (recovery path — next edit kicks off saving)", () => {
    const errored: SaveState = { status: "error", error: "boom" };
    const next = saveStateReducer(errored, { type: "requestSave" });
    expect(next.status).toBe("saving");
    if (next.status === "saving") {
      expect(next.startedAt).toBeInstanceOf(Date);
    }
  });

  it("R7: saved + requestSave → saving (immediate Cmd+S during the saved-sticky window)", () => {
    const saved: SaveState = { status: "saved", savedAt: new Date(0) };
    const next = saveStateReducer(saved, { type: "requestSave" });
    expect(next.status).toBe("saving");
    if (next.status === "saving") {
      expect(next.startedAt).toBeInstanceOf(Date);
    }
  });

  it("savedTimerExpired is a no-op when not in saved state (defensive)", () => {
    const saving: SaveState = { status: "saving", startedAt: new Date(0) };
    const next = saveStateReducer(saving, { type: "savedTimerExpired" });
    expect(next).toEqual(saving);
  });

  it("initialSaveState is idle", () => {
    expect(initialSaveState).toEqual({ status: "idle" });
  });

  it("R8: connectionLost from saving → paused", () => {
    const next = saveStateReducer(
      { status: "saving", startedAt: new Date() },
      { type: "connectionLost" },
    );
    expect(next).toEqual({ status: "paused" });
  });

  it("R9: connectionRestored from paused → idle", () => {
    const next = saveStateReducer(
      { status: "paused" },
      { type: "connectionRestored" },
    );
    expect(next).toEqual({ status: "idle" });
  });

  it("R10: connectionLost from idle → paused (idempotent across source states)", () => {
    const next = saveStateReducer({ status: "idle" }, { type: "connectionLost" });
    expect(next).toEqual({ status: "paused" });
  });

  it("R11: connectionRestored from non-paused state is a no-op", () => {
    const idle: SaveState = { status: "idle" };
    const next = saveStateReducer(idle, { type: "connectionRestored" });
    expect(next).toEqual(idle);
  });
});

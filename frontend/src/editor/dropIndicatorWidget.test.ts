/**
 * dropIndicatorWidget tests — TDD RED/GREEN for C3 (UAT #12).
 *
 * Tests:
 * 1. Module-level smoke: imports the 3 exports without crashing.
 * 2. StateField initial value is null.
 * 3. dropPosField updates when setDropPos effect dispatched.
 */
import { describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { dropIndicatorPlugin, dropPosField, setDropPos } from "./dropIndicatorWidget";

describe("dropIndicatorWidget — smoke + StateField", () => {
  test("all three exports are defined (no import crash)", () => {
    expect(dropIndicatorPlugin).toBeDefined();
    expect(dropPosField).toBeDefined();
    expect(setDropPos).toBeDefined();
  });

  test("dropPosField initial value is null", () => {
    const state = EditorState.create({
      doc: "hello world",
      extensions: [dropPosField],
    });
    expect(state.field(dropPosField)).toBeNull();
  });

  test("setDropPos effect updates dropPosField", () => {
    const state = EditorState.create({
      doc: "hello world",
      extensions: [dropPosField],
    });
    // Dispatch an effect that sets the position to 3
    const newState = state.update({ effects: [setDropPos.of(3)] }).state;
    expect(newState.field(dropPosField)).toBe(3);
  });

  test("setDropPos effect clears dropPosField when null dispatched", () => {
    const state = EditorState.create({
      doc: "hello world",
      extensions: [dropPosField],
    });
    // Set then clear
    const withPos = state.update({ effects: [setDropPos.of(5)] }).state;
    expect(withPos.field(dropPosField)).toBe(5);
    const cleared = withPos.update({ effects: [setDropPos.of(null)] }).state;
    expect(cleared.field(dropPosField)).toBeNull();
  });

  test("dropIndicatorPlugin can be added to EditorState without throwing", () => {
    // The ViewPlugin requires a view to operate, but adding it to state should not crash.
    const state = EditorState.create({
      doc: "hello",
      extensions: [dropPosField, dropIndicatorPlugin],
    });
    expect(state).toBeDefined();
  });
});

/**
 * dropIndicatorWidget tests — smoke + StateField + snapDropPos helper.
 */
import { describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { dropIndicatorPlugin, dropPosField, setDropPos, snapDropPos } from "./dropIndicatorWidget";

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
    const newState = state.update({ effects: [setDropPos.of(3)] }).state;
    expect(newState.field(dropPosField)).toBe(3);
  });

  test("setDropPos effect clears dropPosField when null dispatched", () => {
    const state = EditorState.create({
      doc: "hello world",
      extensions: [dropPosField],
    });
    const withPos = state.update({ effects: [setDropPos.of(5)] }).state;
    expect(withPos.field(dropPosField)).toBe(5);
    const cleared = withPos.update({ effects: [setDropPos.of(null)] }).state;
    expect(cleared.field(dropPosField)).toBeNull();
  });

  test("dropIndicatorPlugin can be added to EditorState without throwing", () => {
    const state = EditorState.create({
      doc: "hello",
      extensions: [dropPosField, dropIndicatorPlugin],
    });
    expect(state).toBeDefined();
  });
});

describe("DI-snap — drop indicator snaps to line boundary", () => {

  function makeState(doc: string) {
    return EditorState.create({ doc, extensions: [] });
  }

  test("DI-snap-1: rawPos in first half of line snaps to line.from", () => {
    const doc = "line one\nfoo bar\nbaz";
    const state = makeState(doc);
    const line2 = state.doc.lineAt(9);
    const rawPos = 10;
    const snapped = snapDropPos(rawPos, state);
    expect(snapped).toBe(line2.from);
  });

  test("DI-snap-2: rawPos in second half of line snaps to line.to", () => {
    const doc = "line one\nfoo bar\nbaz";
    const state = makeState(doc);
    const line2 = state.doc.lineAt(9);
    const rawPos = 15;
    const snapped = snapDropPos(rawPos, state);
    expect(snapped).toBe(line2.to);
  });

  test("DI-snap-3: empty line snaps to line.from (lineLen=0, 0 < 0/2=0 is false, so from)", () => {
    const doc = "before\n\nafter";
    const state = makeState(doc);
    const emptyLine = state.doc.lineAt(7);
    expect(emptyLine.text).toBe("");
    const snapped = snapDropPos(7, state);
    expect(snapped).toBeGreaterThanOrEqual(emptyLine.from);
    expect(snapped).toBeLessThanOrEqual(emptyLine.to);
  });
});

/**
 * dropIndicatorWidget tests — TDD RED/GREEN for C3 (UAT #12) + Plan 07-28 snap-to-line.
 *
 * Tests:
 * 1. Module-level smoke: imports the 3 exports without crashing.
 * 2. StateField initial value is null.
 * 3. dropPosField updates when setDropPos effect dispatched.
 * 4. (Plan 07-28) snapDropPos helper snaps to line.from/line.to correctly.
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

describe("DI-snap — drop indicator snaps to line boundary (UAT-2 R1-6 / Plan 07-28)", () => {
  // Doc: "line one\nfoo bar\nbaz"
  //       positions: 0-8\n = line 1 (len 8), 9-15\n = line 2 (len 6 "foo bar"), 17-19 = line 3
  //
  // snapDropPos(rawPos, state) is a pure exported helper so we can test it
  // without a live EditorView.

  function makeState(doc: string) {
    return EditorState.create({ doc, extensions: [] });
  }

  test("DI-snap-1: rawPos in first half of line snaps to line.from", () => {
    // doc: "line one\nfoo bar\nbaz"
    // line 2 = "foo bar", from=9, to=16 (positions 9..15 + newline at 16? let's compute)
    // "line one\n" = 9 chars (indices 0-8), line 2 starts at 9
    // "foo bar" = 7 chars, so line 2: from=9, to=15 (length 7 = to-from, to is exclusive)
    const doc = "line one\nfoo bar\nbaz";
    const state = makeState(doc);
    const line2 = state.doc.lineAt(9); // line containing "foo bar"
    // rawPos near start of "foo bar" (e.g., pos 10 = "o", colInLine=1, lineLen=7, 1 < 3.5 → snap to from)
    const rawPos = 10; // "f" is at 9, "o" at 10 — colInLine=1 < 7/2=3.5 → from
    const snapped = snapDropPos(rawPos, state);
    expect(snapped).toBe(line2.from); // 9
  });

  test("DI-snap-2: rawPos in second half of line snaps to line.to", () => {
    // same doc, pos near end of "foo bar"
    // "foo bar" = positions 9-15; "r" is at 15, colInLine=6; 6 >= 7/2=3.5 → snap to to
    const doc = "line one\nfoo bar\nbaz";
    const state = makeState(doc);
    const line2 = state.doc.lineAt(9);
    const rawPos = 15; // "r" in "foo bar", colInLine=6 >= 3.5 → to
    const snapped = snapDropPos(rawPos, state);
    expect(snapped).toBe(line2.to); // 16
  });

  test("DI-snap-3: empty line snaps to line.from (lineLen=0, 0 < 0/2=0 is false, so from)", () => {
    // An empty line: lineLen=0. colInLine=0. The condition: colInLine < lineLen/2 → 0 < 0 → false
    // So we snap to line.to, but .from === .to for an empty line → either is correct.
    const doc = "before\n\nafter";
    const state = makeState(doc);
    const emptyLine = state.doc.lineAt(7); // the empty line between "before" and "after"
    expect(emptyLine.text).toBe(""); // confirm it's empty
    const snapped = snapDropPos(7, state);
    // Both from and to are equal for empty lines; just assert it's a valid position in the line.
    expect(snapped).toBeGreaterThanOrEqual(emptyLine.from);
    expect(snapped).toBeLessThanOrEqual(emptyLine.to);
  });
});

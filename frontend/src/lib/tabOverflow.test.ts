/**
 * tabOverflow tests — the pure shrink-then-dropdown decision (TAB-16/17).
 *
 * Arrays + numbers only: no render, no ResizeObserver, no timers. Each case
 * pins the returned hidden Set so the overflow logic is provably deterministic.
 */
import { describe, it, expect } from "vitest";
import {
  computeHiddenTabIds,
  computeDropIndex,
  clampIndexToPinnedBoundary,
  MIN_TAB_WIDTH,
  MAX_TAB_WIDTH,
} from "./tabOverflow";
import { RESERVED } from "../components/TabStrip";

const OVERFLOW = 28;
const base = {
  minTabWidth: MIN_TAB_WIDTH,
  overflowButtonWidth: OVERFLOW,
};

describe("computeHiddenTabIds", () => {
  it("constants: MIN < MAX", () => {
    expect(MIN_TAB_WIDTH).toBe(120);
    expect(MAX_TAB_WIDTH).toBe(185);
    expect(MIN_TAB_WIDTH).toBeLessThan(MAX_TAB_WIDTH);
  });

  it("(a) availableWidth <= 0 → empty set (jsdom / pre-layout escape hatch)", () => {
    expect(
      computeHiddenTabIds({ ...base, tabIds: ["a", "b", "c"], activeTabId: "a", availableWidth: 0 }),
    ).toEqual(new Set());
    expect(
      computeHiddenTabIds({ ...base, tabIds: ["a", "b", "c"], activeTabId: "a", availableWidth: -50 }),
    ).toEqual(new Set());
  });

  it("(b) all tabs fit at min width → empty set", () => {
    // floor(400/120) = 3 ≥ 3 tabs → nothing hidden.
    expect(
      computeHiddenTabIds({ ...base, tabIds: ["a", "b", "c"], activeTabId: "a", availableWidth: 400 }),
    ).toEqual(new Set());
  });

  it("(c) overflow, active inside the first window → trailing tabs hidden, active visible", () => {
    // floor(400/120)=3 < 5 → overflow. visibleCount=floor((400-28)/120)=3 → keep a,b,c.
    const hidden = computeHiddenTabIds({
      ...base,
      tabIds: ["a", "b", "c", "d", "e"],
      activeTabId: "a",
      availableWidth: 400,
    });
    expect(hidden).toEqual(new Set(["d", "e"]));
    expect(hidden.has("a")).toBe(false);
  });

  it("(d) overflow, active outside the first window → last kept evicted, active stays visible", () => {
    // visibleCount=3 → first window a,b,c; active 'e' swaps for last kept 'c'.
    const hidden = computeHiddenTabIds({
      ...base,
      tabIds: ["a", "b", "c", "d", "e"],
      activeTabId: "e",
      availableWidth: 400,
    });
    expect(hidden).toEqual(new Set(["c", "d"]));
    expect(hidden.has("e")).toBe(false);
  });

  it("(e) boundary: the dropdown reservation pushes one extra tab into overflow", () => {
    // availableWidth 365: fitAll=floor(365/120)=3, but visibleCount=floor((365-28)/120)=2.
    // 4 tabs > 3 → overflow; reservation shrinks the visible window to 2.
    const hidden = computeHiddenTabIds({
      ...base,
      tabIds: ["a", "b", "c", "d"],
      activeTabId: "a",
      availableWidth: 365,
    });
    expect(hidden).toEqual(new Set(["c", "d"]));
  });

  it("(f) activeTabId null → sensible first-N-visible split", () => {
    const hidden = computeHiddenTabIds({
      ...base,
      tabIds: ["a", "b", "c", "d", "e"],
      activeTabId: null,
      availableWidth: 400,
    });
    expect(hidden).toEqual(new Set(["d", "e"]));
  });

  it("always keeps at least one tab visible even in a very narrow strip", () => {
    // availableWidth 60 (< min): fitAll=0 < 3 → overflow; visibleCount=max(1, floor((60-28)/120))=1.
    const hidden = computeHiddenTabIds({
      ...base,
      tabIds: ["a", "b", "c"],
      activeTabId: "b",
      availableWidth: 60,
    });
    // Active 'b' is the single kept tab.
    expect(hidden).toEqual(new Set(["a", "c"]));
  });

  it("active tab not in the list is ignored (no crash, plain first-N split)", () => {
    const hidden = computeHiddenTabIds({
      ...base,
      tabIds: ["a", "b", "c", "d", "e"],
      activeTabId: "zzz",
      availableWidth: 400,
    });
    expect(hidden).toEqual(new Set(["d", "e"]));
  });

  it("empty tab list → empty set", () => {
    expect(
      computeHiddenTabIds({ ...base, tabIds: [], activeTabId: null, availableWidth: 400 }),
    ).toEqual(new Set());
  });

  it("(g) drift guard: TabStrip's RESERVED matches its left-cluster arithmetic (260721-cjt: right-cluster toggle is conditional)", () => {
    // Left cluster: 28 + 8 + 1 = 37. Strip chrome: 8 (padding) + 32 (new-tab
    // button — grew from 26 in UAT gap-closure group B item 6, when the
    // button's margin changed from "0 0 4px 2px" to "0 4px" for L/R padding +
    // vertical centering: 24 width + 8 margin = 32). RESERVED itself stays 77
    // and does NOT include the right cluster: the rail-reopen toggle is
    // conditional (collapsed rail AND rightmost leaf only, 260721-cjt) and
    // reserved dynamically inside the component's overflow-measurement effect
    // (RIGHT_CLUSTER, subtracted only when the toggle actually renders), not
    // baked into this constant.
    const leftCluster = 37;
    const expectedReserved = 8 + 32 + leftCluster;

    expect(expectedReserved).toBe(77);
    expect(RESERVED).toBe(expectedReserved);
  });
});

describe("computeDropIndex", () => {
  it("(h) WR-03 interleaved trace: tabs=[a,b,c,d,e], drag 'a' before 'e' with c,d hidden between b and e — 'a' lands adjacent to the visible window, not swallowed into overflow", () => {
    const tabIds = ["a", "b", "c", "d", "e"];
    const activeTabId = "e";
    const availableWidth = 400;
    // visibleCount = floor((400-28)/120) = 3; front window [a,b,c], active 'e'
    // falls outside it, evicts 'c' -> visible=[a,b,e], hidden={c,d}. Matches
    // the review's exact repro (18.1-REVIEW.md WR-03).
    const hidden = computeHiddenTabIds({ ...base, tabIds, activeTabId, availableWidth });
    expect(hidden).toEqual(new Set(["c", "d"]));
    const visibleTabIds = tabIds.filter((id) => !hidden.has(id));
    expect(visibleTabIds).toEqual(["a", "b", "e"]);

    // Drag 'a' (fromIndex 0); drop indicator sits between 'b' and 'e' -> targetId 'e'.
    // prevVisible = visibleTabIds[visIdx('e') - 1] = 'b'; toIdx = tabIds.indexOf('b') + 1 = 2.
    const toIdx = computeDropIndex({ tabIds, visibleTabIds, targetId: "e" });
    expect(toIdx).toBe(2);

    // Splice-first compensation (mirrors TabStrip.handleStripPointerUp, gap 6 / WR-01):
    // fromIndex(0) < toIdx(2) -> adjusted = toIdx - 1 = 1.
    const adjusted = 0 < toIdx ? toIdx - 1 : toIdx;
    const reordered = [...tabIds];
    const [moved] = reordered.splice(0, 1);
    reordered.splice(adjusted, 0, moved);
    expect(reordered).toEqual(["b", "a", "c", "d", "e"]);

    // Recompute hidden on the new order: 'a' must NOT be swallowed into overflow.
    const hiddenAfter = computeHiddenTabIds({
      ...base,
      tabIds: reordered,
      activeTabId,
      availableWidth,
    });
    expect(hiddenAfter.has("a")).toBe(false);
  });

  it("(i) WR-03 end-of-strip fallback: dropping past the last visible tab lands the dragged tab immediately after it, not swallowed among interleaved hidden tabs", () => {
    const tabIds = ["a", "b", "c", "d", "e"];
    const visibleTabIds = ["a", "b", "e"]; // c,d hidden and interleaved before 'e'

    // targetId null = past all visible pills; prevVisible = last visible = 'e';
    // toIdx = tabIds.indexOf('e') + 1 = 5 (append past the end of the full array).
    const toIdx = computeDropIndex({ tabIds, visibleTabIds, targetId: null });
    expect(toIdx).toBe(5);

    const adjusted = 0 < toIdx ? toIdx - 1 : toIdx;
    const reordered = [...tabIds];
    const [moved] = reordered.splice(0, 1);
    reordered.splice(adjusted, 0, moved);
    // 'a' lands immediately after 'e' (the last visible tab) — not squeezed
    // between the interleaved hidden 'c'/'d'.
    expect(reordered).toEqual(["b", "c", "d", "e", "a"]);
    expect(reordered.indexOf("a")).toBe(reordered.indexOf("e") + 1);
  });

  it("(j) non-interleaved regression: trailing-hidden drop between two visible tabs matches the old tabs.findIndex(targetId) result unchanged", () => {
    const tabIds = ["a", "b", "c", "d", "e"];
    const visibleTabIds = ["a", "b", "c"]; // d,e trailing-hidden, no interleaving

    // Old buggy code: toIdx = tabs.findIndex(t => t.id === 'c') = 2.
    // New fn: prevVisible = visibleTabIds[visIdx('c') - 1] = 'b'; toIdx = tabIds.indexOf('b') + 1 = 2.
    const toIdx = computeDropIndex({ tabIds, visibleTabIds, targetId: "c" });
    expect(toIdx).toBe(2);
    expect(toIdx).toBe(tabIds.findIndex((id) => id === "c"));
  });

  it("(k) drop onto the first visible tab -> no prevVisible, toIdx 0", () => {
    const tabIds = ["a", "b", "c"];
    const visibleTabIds = ["a", "b", "c"];
    expect(computeDropIndex({ tabIds, visibleTabIds, targetId: "a" })).toBe(0);
  });

  it("(l) targetId not present in visibleTabIds -> -1 (caller no-ops)", () => {
    const tabIds = ["a", "b", "c"];
    const visibleTabIds = ["a", "b", "c"];
    expect(computeDropIndex({ tabIds, visibleTabIds, targetId: "zzz" })).toBe(-1);
  });

  it("(m) empty visibleTabIds with targetId null -> 0 (no prevVisible, nothing to be adjacent to)", () => {
    expect(
      computeDropIndex({ tabIds: [], visibleTabIds: [], targetId: null }),
    ).toBe(0);
  });
});

describe("clampIndexToPinnedBoundary (D-15/D-16 pinned-region drag/insert clamp)", () => {
  it("an UNPINNED mover's index is clamped to >= pinnedCount (never lands inside the pinned region)", () => {
    // Wants to land at index 1 (inside a 3-tab pinned group) — must clamp up to 3.
    expect(clampIndexToPinnedBoundary(1, 3, false)).toBe(3);
    // Already at/after the boundary — passes through unchanged.
    expect(clampIndexToPinnedBoundary(3, 3, false)).toBe(3);
    expect(clampIndexToPinnedBoundary(5, 3, false)).toBe(5);
  });

  it("a PINNED mover's index is clamped to <= pinnedCount (never lands outside the pinned region)", () => {
    // Wants to land at index 5 (well past a 2-tab pinned group) — must clamp down to 2.
    expect(clampIndexToPinnedBoundary(5, 2, true)).toBe(2);
    // Already within the pinned region — passes through unchanged.
    expect(clampIndexToPinnedBoundary(0, 2, true)).toBe(0);
    expect(clampIndexToPinnedBoundary(2, 2, true)).toBe(2);
  });

  it("pinnedCount 0 (no pinned tabs): unpinned is never clamped, pinned is always forced to 0", () => {
    expect(clampIndexToPinnedBoundary(4, 0, false)).toBe(4);
    expect(clampIndexToPinnedBoundary(4, 0, true)).toBe(0);
  });

  it("the -1 sentinel (no valid drop target) passes through unchanged for both directions", () => {
    expect(clampIndexToPinnedBoundary(-1, 3, false)).toBe(-1);
    expect(clampIndexToPinnedBoundary(-1, 3, true)).toBe(-1);
  });
});

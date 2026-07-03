/**
 * tabOverflow tests — the pure shrink-then-dropdown decision (TAB-16/17).
 *
 * Arrays + numbers only: no render, no ResizeObserver, no timers. Each case
 * pins the returned hidden Set so the overflow logic is provably deterministic.
 */
import { describe, it, expect } from "vitest";
import {
  computeHiddenTabIds,
  MIN_TAB_WIDTH,
  MAX_TAB_WIDTH,
} from "./tabOverflow";
import { PANEL_SELECTOR_TRIGGER_WIDTH } from "../components/PanelSelectorDropdown";
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

  it("(g) drift guard: TabStrip's RESERVED stays composed from PANEL_SELECTOR_TRIGGER_WIDTH (IN-06)", () => {
    // Right cluster: 1 (borderLeft) + 8 (paddingLeft) + PANEL_SELECTOR_TRIGGER_WIDTH
    // + 4 (flex gap) + 28 (right toggle). Left cluster: 28 + 8 + 1 = 37.
    // Strip chrome: 8 (padding) + 26 (new-tab button).
    const rightCluster = 1 + 8 + PANEL_SELECTOR_TRIGGER_WIDTH + 4 + 28;
    const leftCluster = 37;
    const expectedReserved = 8 + 26 + rightCluster + leftCluster;

    expect(expectedReserved).toBe(136);
    expect(RESERVED).toBe(expectedReserved);
  });
});

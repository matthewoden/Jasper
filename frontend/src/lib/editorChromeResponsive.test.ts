import { describe, expect, it } from "vitest";
import {
  computeBreadcrumbReserve,
  computeChromeVisibility,
  STAR_HIDE_WIDTH,
  WORD_COUNT_HIDE_WIDTH,
} from "./editorChromeResponsive";

describe("computeChromeVisibility", () => {
  it("jsdom/pre-layout escape hatch: barWidth <= 0 shows everything", () => {
    expect(computeChromeVisibility(0)).toEqual({ showWordCount: true, showStar: true });
    expect(computeChromeVisibility(-10)).toEqual({ showWordCount: true, showStar: true });
  });

  it("wide bar shows word count and star", () => {
    expect(computeChromeVisibility(900)).toEqual({ showWordCount: true, showStar: true });
  });

  it("medium bar (below WORD_COUNT_HIDE_WIDTH) hides word count only", () => {
    expect(computeChromeVisibility(WORD_COUNT_HIDE_WIDTH - 1)).toEqual({
      showWordCount: false,
      showStar: true,
    });
  });

  it("narrow bar (below STAR_HIDE_WIDTH) hides both word count and star", () => {
    expect(computeChromeVisibility(STAR_HIDE_WIDTH - 1)).toEqual({
      showWordCount: false,
      showStar: false,
    });
  });

  it("boundary values are inclusive (>=)", () => {
    expect(computeChromeVisibility(WORD_COUNT_HIDE_WIDTH).showWordCount).toBe(true);
    expect(computeChromeVisibility(STAR_HIDE_WIDTH).showStar).toBe(true);
  });
});

describe("computeBreadcrumbReserve", () => {
  it("jsdom/pre-layout escape hatch: barWidth <= 0 reserves nothing", () => {
    expect(computeBreadcrumbReserve({ barWidth: 0, clusterWidth: 150 })).toBe(0);
  });

  it("wide bar (natural gap exceeds cluster+gap) reserves nothing", () => {
    // barWidth 1900 -> naturalGap = (1900-760)/2 = 570, comfortably > 150+8.
    expect(computeBreadcrumbReserve({ barWidth: 1900, clusterWidth: 150 })).toBe(0);
  });

  it("bar exactly at the column width (no natural gap) reserves cluster width + gap", () => {
    expect(computeBreadcrumbReserve({ barWidth: 760, clusterWidth: 150 })).toBe(158);
  });

  it("narrow bar below the column width reserves cluster width + gap", () => {
    expect(computeBreadcrumbReserve({ barWidth: 400, clusterWidth: 100 })).toBe(108);
  });

  it("bar just past the column width reserves the shortfall only", () => {
    // barWidth 800 -> naturalGap = 20; reserve = 150+8-20 = 138.
    expect(computeBreadcrumbReserve({ barWidth: 800, clusterWidth: 150 })).toBe(138);
  });

  it("never returns a negative reserve", () => {
    expect(computeBreadcrumbReserve({ barWidth: 5000, clusterWidth: 150 })).toBe(0);
  });
});

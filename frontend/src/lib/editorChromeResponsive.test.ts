import { describe, expect, it } from "vitest";
import {
  computeBreadcrumbMaxWidth,
  computeChromeVisibility,
  STAR_HIDE_WIDTH,
} from "./editorChromeResponsive";

describe("computeChromeVisibility", () => {
  it("jsdom/pre-layout escape hatch: barWidth <= 0 shows the star", () => {
    expect(computeChromeVisibility(0)).toEqual({ showStar: true });
    expect(computeChromeVisibility(-10)).toEqual({ showStar: true });
  });

  it("wide bar shows the star", () => {
    expect(computeChromeVisibility(900)).toEqual({ showStar: true });
  });

  it("narrow bar (below STAR_HIDE_WIDTH) hides the star", () => {
    expect(computeChromeVisibility(STAR_HIDE_WIDTH - 1)).toEqual({
      showStar: false,
    });
  });

  it("boundary value is inclusive (>=)", () => {
    expect(computeChromeVisibility(STAR_HIDE_WIDTH).showStar).toBe(true);
  });
});

describe("computeBreadcrumbMaxWidth", () => {
  it("jsdom/pre-layout escape hatch: barWidth <= 0 returns undefined (no cap)", () => {
    expect(computeBreadcrumbMaxWidth({ barWidth: 0, clusterWidth: 150 })).toBeUndefined();
  });

  it("wide bar reserves symmetric headroom around the cluster", () => {
    // barWidth 1900 -> cap = 1900 - 2*(150+8) = 1584.
    expect(computeBreadcrumbMaxWidth({ barWidth: 1900, clusterWidth: 150 })).toBe(1584);
  });

  it("narrow bar shrinks the cap proportionally", () => {
    // barWidth 400 -> cap = 400 - 2*(100+8) = 184.
    expect(computeBreadcrumbMaxWidth({ barWidth: 400, clusterWidth: 100 })).toBe(184);
  });

  it("never returns a negative cap", () => {
    // barWidth 200 -> raw = 200 - 2*(150+8) = -116 -> clamped to 0.
    expect(computeBreadcrumbMaxWidth({ barWidth: 200, clusterWidth: 150 })).toBe(0);
  });

  it("respects a custom gap", () => {
    expect(computeBreadcrumbMaxWidth({ barWidth: 800, clusterWidth: 150, gap: 20 })).toBe(
      800 - 2 * 170,
    );
  });
});

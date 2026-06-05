import { describe, it, expect } from "vitest";
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, nextDelay } from "./backoff";

describe("nextDelay", () => {
  it("attempt=0: 1s base × [0.5, 1.5) jitter", () => {
    expect(nextDelay(0, () => 0)).toBe(500);
    expect(nextDelay(0, () => 0.999)).toBe(1499);
  });

  it("attempt=3: 8s × jitter", () => {
    expect(nextDelay(3, () => 0)).toBe(4000);
    expect(nextDelay(3, () => 0.999)).toBe(11_992);
  });

  it("caps at 30s nominal for attempt >= 5", () => {
    expect(nextDelay(5, () => 0)).toBe(BACKOFF_CAP_MS / 2);
    expect(nextDelay(20, () => 0)).toBe(BACKOFF_CAP_MS / 2);
    expect(nextDelay(20, () => 0.999)).toBeLessThanOrEqual(BACKOFF_CAP_MS * 1.5);
  });

  it("constants exported with locked values (D-04)", () => {
    expect(BACKOFF_BASE_MS).toBe(1_000);
    expect(BACKOFF_CAP_MS).toBe(30_000);
  });

  it("attempt=0 with 5 distinct rng draws produces 5 distinct delays (jitter dispersion)", () => {
    const draws = [0.0, 0.2, 0.4, 0.6, 0.8];
    const delays = draws.map((r) => nextDelay(0, () => r));
    expect(delays).toEqual([500, 700, 900, 1100, 1300]);
    const span = Math.max(...delays) - Math.min(...delays);
    expect(span).toBeGreaterThan(700);
  });

  it("identical rng draw produces identical delay (proves the rng seam works)", () => {
    expect(nextDelay(0, () => 0.42)).toBe(nextDelay(0, () => 0.42));
  });
});

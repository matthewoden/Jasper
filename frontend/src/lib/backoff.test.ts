import { describe, it, expect } from "vitest";
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, nextDelay } from "./backoff";

describe("nextDelay", () => {
  it("attempt=0: 1s base × [0.5, 1.5) jitter", () => {
    expect(nextDelay(0, () => 0)).toBe(500);
    expect(nextDelay(0, () => 0.999)).toBe(1499);
  });

  it("attempt=3: 8s × jitter", () => {
    expect(nextDelay(3, () => 0)).toBe(4000);
    expect(nextDelay(3, () => 0.999)).toBe(11_992); // floor(8000 * (0.5 + 0.999)) = floor(11992)
  });

  it("caps at 30s nominal for attempt >= 5", () => {
    expect(nextDelay(5, () => 0)).toBe(BACKOFF_CAP_MS / 2); // 15000
    expect(nextDelay(20, () => 0)).toBe(BACKOFF_CAP_MS / 2);
    expect(nextDelay(20, () => 0.999)).toBeLessThanOrEqual(BACKOFF_CAP_MS * 1.5);
  });

  it("constants exported with locked values (D-04)", () => {
    expect(BACKOFF_BASE_MS).toBe(1_000);
    expect(BACKOFF_CAP_MS).toBe(30_000);
  });
});

/**
 * Jittered exponential backoff for WS reconnect.
 * 1s base, doubles per attempt, 30s cap, 0.5–1.5× jitter, retries forever.
 *
 *   attempt 0 → [500, 1499] ms
 *   attempt 1 → [1000, 2999] ms
 *   attempt 2 → [2000, 5999] ms
 *   attempt 3 → [4000, 11999] ms
 *   attempt 4 → [8000, 23999] ms
 *   attempt N≥5 → [15000, 44999] ms (BACKOFF_CAP_MS dominates)
 *
 * `rng` is injectable for deterministic tests (default Math.random).
 */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;

export function nextDelay(
  attempt: number,
  rng: () => number = Math.random,
): number {
  const nominal = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  const jitter = 0.5 + rng();
  return Math.floor(nominal * jitter);
}

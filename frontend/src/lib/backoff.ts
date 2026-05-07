/**
 * SYNC-07: jittered exponential backoff for WS reconnect.
 *
 * Locked by D-04: 1s base, double per attempt, 30s cap,
 * 0.5–1.5× jitter, retry FOREVER (no max-attempt cap).
 *
 *   attempt 0 → 1s × jitter   ([500, 1499] ms)
 *   attempt 1 → 2s × jitter   ([1000, 2999] ms)
 *   attempt 2 → 4s × jitter   ([2000, 5999] ms)
 *   attempt 3 → 8s × jitter   ([4000, 11999] ms)
 *   attempt 4 → 16s × jitter  ([8000, 23999] ms)
 *   attempt 5 → 30s × jitter  ([15000, 44999] ms — but capped, see below)
 *   attempt N (N >= 5) → 30s × jitter  (BACKOFF_CAP_MS dominates)
 *
 * Pure function — `rng` is injectable for deterministic tests
 * (default Math.random).
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

/**
 * Jittered exponential backoff for WS reconnect: 1s base, doubles per attempt,
 * 30s cap, 0.5–1.5x jitter, retries forever.
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

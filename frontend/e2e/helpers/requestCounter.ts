/**
 * requestCounter.ts — reusable wire-request counting for the request-budget
 * assertions across the DoD spec (and any future request-count E2E).
 *
 * CRITICAL (memory e2e-needs-make-build): Playwright here runs against the
 * EMBEDDED Go binary — run `make build` (NOT `npm run build`) at the repo
 * root before invoking any spec that imports this helper, or the served
 * page is stale and every assertion below is meaningless.
 *
 * Reuses the `page.on("request", ...)` URL-filter mechanism already proven
 * in `phase5_5-uat.spec.ts` (UX-14b) — no new counting mechanism.
 */
import { expect, type Page } from "@playwright/test";

export interface RequestCounterHandle {
  /** Number of matching requests observed since the last reset() (or since attach). */
  count(): number;
  /** Full URLs of every matching request observed, in arrival order. */
  urls(): string[];
  /** Clear the recorded list without detaching the listener. */
  reset(): void;
}

/**
 * Attach a `page.on("request", ...)` listener filtered by HTTP method and a
 * URL pattern. Callers should pass an ANCHORED pattern against the API
 * prefix, e.g. `/\/api\/v1\/mcp\/grants(?:\?|$)/` or `/\/api\/v1\/tags(?:\?|$)/`.
 *
 * The `(?:\?|$)` tail is load-bearing: without it `/tags` would also match
 * `/tags/{name}/notes`, and a keyed endpoint like `/notes/{id}/backlinks`
 * would incorrectly match a plain `/notes` list request. Anchor every
 * pattern passed here, even for endpoints that don't currently have a
 * same-prefix sibling — a future endpoint might introduce one.
 *
 * The listener is attached for the lifetime of the page; there is no
 * detach() because Playwright tears down all listeners with the page.
 */
export function countRequests(
  page: Page,
  pattern: RegExp,
  method = "GET",
): RequestCounterHandle {
  let seen: string[] = [];

  page.on("request", (req) => {
    if (req.method() !== method) return;
    if (!pattern.test(req.url())) return;
    seen.push(req.url());
  });

  return {
    count: () => seen.length,
    urls: () => [...seen],
    reset: () => {
      seen = [];
    },
  };
}

/**
 * Poll-based quiescence helper: resolves once the page's in-flight request
 * count has stopped growing across two consecutive checks (poll interval
 * 100ms, hard cap 5s). Tracks ALL requests fired by the page (not scoped to
 * a single `countRequests()` pattern) so callers can settle before reading
 * ANY counter's `.count()`. Implemented with `expect.poll` per project
 * memory [no-flaky-tests] — never a fixed-duration sleep.
 * `phase5_5-uat.spec.ts`'s fixed 500ms sleeps are a pre-existing convention
 * this helper deliberately does not copy forward.
 */
export async function settle(page: Page): Promise<void> {
  let totalSeen = 0;
  const onRequest = (): void => {
    totalSeen++;
  };
  page.on("request", onRequest);

  let lastCount = -1;
  let stableStreak = 0;

  try {
    await expect
      .poll(
        () => {
          if (totalSeen === lastCount) {
            stableStreak++;
          } else {
            stableStreak = 0;
            lastCount = totalSeen;
          }
          return stableStreak;
        },
        { timeout: 5_000, intervals: [100] },
      )
      .toBeGreaterThanOrEqual(2);
  } finally {
    page.off("request", onRequest);
  }
}

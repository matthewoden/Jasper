/**
 * The E2E suite's single local-calendar date formatter.
 *
 * DO NOT use `new Date().toISOString().slice(0, 10)` here or at any call site.
 * The product computes a daily note's date from the browser's LOCAL calendar
 * (useDailyNote.ts) and the backend writes `daily/<date>.md` verbatim from
 * whatever the frontend sent, so a UTC date disagrees with what is on disk
 * between local midnight and UTC midnight. Observed directly: 360 passed / 6
 * failed at 23:44 CDT, 366 / 0 at 06:48 next morning, identical code.
 *
 * Pinning a timezone in playwright.config.ts is NOT the fix — it hides the
 * mismatch rather than removing it. Tests must compute the way the product does.
 */
export function localDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * localDate.ts — the E2E suite's single local-calendar date formatter.
 *
 * The product computes a daily note's date from the browser's LOCAL
 * calendar, not UTC: `frontend/src/lib/useDailyNote.ts` builds `today` via
 * `now.getFullYear()`/`now.getMonth()`/`now.getDate()`. The backend never
 * computes a date itself — `backend/internal/api/daily.go` only regex-
 * validates the incoming `YYYY-MM-DD` path segment, and
 * `notes.Service.GetOrCreateDailyNote` writes `daily/<date>.md` verbatim
 * using whatever date string the frontend sent. So the date this suite
 * must expect is whatever the LOCAL calendar says, exactly as
 * useDailyNote.ts computes it.
 *
 * This is deliberate, not a bug: Obsidian parity means that at 11pm the
 * user wants tonight's daily note, not tomorrow's UTC date. Tests must
 * match the product's behavior rather than the other way round.
 *
 * DO NOT use `new Date().toISOString().slice(0, 10)` here or at any call
 * site. `toISOString()` renders the date in UTC, so between local midnight
 * and UTC midnight — every evening west of Greenwich (and every morning
 * east of it) — it disagrees with the LOCAL date the product actually
 * writes to disk, and the assertion fails against a correct app. This was
 * observed directly: 360 passed / 6 failed at 23:44 CDT, then 366 passed /
 * 0 failed at 06:48 the next morning, with identical code — the only thing
 * that changed was which side of local midnight the machine's clock was on.
 *
 * Pinning a timezone in `playwright.config.ts` is NOT the fix for this —
 * it would only hide the local/UTC mismatch instead of removing it. Tests
 * must compute the same way the product does, in whatever zone they run.
 */
export function localDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

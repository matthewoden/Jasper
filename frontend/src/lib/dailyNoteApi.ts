/**
 * dailyNoteApi — typed wrapper around the daily-note endpoints.
 *
 * Get-or-create today's daily note across two verbs: GET reads (404 when
 * absent), POST creates. They were a single get-or-create GET;
 * splitting them is what puts creation behind the Origin guard, since a
 * cross-origin `<img src=".../daily-notes/2099-12-31">` was otherwise enough
 * to write a file into the vault.
 *
 * Date string format: YYYY-MM-DD. Server validates the regex and returns 400
 * on malformed input (mitigated by server-side guard).
 */

import { client } from "../api/client";
import type { components } from "../api/schema";
import { createKeyedResource } from "./resources";

export type NoteDetail = components["schemas"]["NoteDetail"];

async function createDailyNote(date: string): Promise<NoteDetail> {
  const { data, error } = await client.POST("/daily-notes/{date}", {
    params: { path: { date } },
  });
  if (error) throw new Error("openTodayDailyNote: " + JSON.stringify(error));
  if (!data) throw new Error("openTodayDailyNote: empty response");
  return data;
}

async function fetchDailyNote(date: string): Promise<NoteDetail> {
  const { data, error, response } = await client.GET("/daily-notes/{date}", {
    params: { path: { date } },
  });
  // 404 is the ordinary "not written yet" case, not a failure — check it
  // before the error branch, which a 404 also populates.
  if (response?.status === 404) return createDailyNote(date);
  if (error) throw new Error("openTodayDailyNote: " + JSON.stringify(error));
  if (!data) throw new Error("openTodayDailyNote: empty response");
  return data;
}

// Pass-through, never cached: the note can be created or deleted outside
// this client, so a cached response would hide the change. Still keyed +
// coalesced — a double-click on "Today's note" for the same date
// produces one request pair, not two, on top of useDailyNote's own
// dailyNoteLoading re-entrancy guard.
const dailyNoteResource = createKeyedResource("dailyNote", fetchDailyNote, {
  mode: "pass-through",
});

/**
 * Get-or-create today's daily note (DAILY-01).
 * Returns 200 (existing) or 201 (created).
 * Throws on HTTP error so the caller (useDailyNote) can catch and show a toast.
 *
 * @param date - ISO date string in YYYY-MM-DD format (e.g. "2026-05-14")
 */
export async function openTodayDailyNote(date: string): Promise<NoteDetail> {
  return dailyNoteResource.forKey(date).read();
}

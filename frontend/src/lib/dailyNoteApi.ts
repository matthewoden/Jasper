/**
 * dailyNoteApi — typed wrapper around GET /api/v1/daily-notes/{date}.
 *
 * Get-or-create today's daily note (200 on hit, 201 on create).
 * Date string format: YYYY-MM-DD. Server validates the regex and returns 400
 * on malformed input (mitigated by server-side guard).
 */

import { client } from "../api/client";
import type { components } from "../api/schema";
import { createKeyedResource } from "./resources";

export type NoteDetail = components["schemas"]["NoteDetail"];

async function fetchDailyNote(date: string): Promise<NoteDetail> {
  const { data, error } = await client.GET("/daily-notes/{date}", {
    params: { path: { date } },
  });
  if (error) throw new Error("openTodayDailyNote: " + JSON.stringify(error));
  if (!data) throw new Error("openTodayDailyNote: empty response");
  return data;
}

// Pass-through, never cached: this endpoint creates the note as a side
// effect of a GET, so a cached response would hide a subsequent external
// deletion. Still keyed + coalesced (D-05) — a double-click on "Today's
// note" for the same date produces one request, not two, on top of
// useDailyNote's own dailyNoteLoading re-entrancy guard.
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

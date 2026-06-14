/**
 * dailyNoteApi — typed wrapper around GET /api/v1/daily-notes/{date}.
 *
 * Get-or-create today's daily note (200 on hit, 201 on create).
 * Date string format: YYYY-MM-DD. Server validates the regex and returns 400
 * on malformed input (mitigated by server-side guard).
 */

import { client } from "../api/client";
import type { components } from "../api/schema";

export type NoteDetail = components["schemas"]["NoteDetail"];

/**
 * Get-or-create today's daily note (DAILY-01).
 * Returns 200 (existing) or 201 (created).
 * Throws on HTTP error so the caller (useDailyNote) can catch and show a toast.
 *
 * @param date - ISO date string in YYYY-MM-DD format (e.g. "2026-05-14")
 */
export async function openTodayDailyNote(date: string): Promise<NoteDetail> {
  const { data, error } = await client.GET("/daily-notes/{date}", {
    params: { path: { date } },
  });
  if (error) throw new Error("openTodayDailyNote: " + JSON.stringify(error));
  if (!data) throw new Error("openTodayDailyNote: empty response");
  return data;
}

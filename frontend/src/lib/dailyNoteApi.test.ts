/**
 * Tests for dailyNoteApi — typed GET /daily-notes/{date} wrapper, backed by
 * a pass-through keyed resource (D-05: never cached, still coalesced).
 *
 * The client module is mocked so tests can spy on .GET calls without
 * a real network connection. Coverage:
 *   - Happy path: returns NoteDetail on 200/201
 *   - Error path: throws on client error
 *   - Empty response: throws on missing data
 *   - Correct path key + params passed through
 *   - Concurrent same-date calls coalesce into one client.GET
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();

vi.mock("../api/client", () => ({
  client: {
    GET: (...args: unknown[]) => getMock(...args),
  },
}));

import { openTodayDailyNote } from "./dailyNoteApi";
import { __testing__ as resourcesTesting } from "./resources/createResource";

const TODAY = "2026-05-14";

const fakeNote = {
  id: "00000000-0000-4000-a000-000000000099",
  path: "daily/2026-05-14.md",
  content: "---\ntags: []\n---\n\n# 2026-05-14\n\n",
  updated_at: "2026-05-14T08:00:00Z",
};

describe("openTodayDailyNote", () => {
  beforeEach(() => {
    getMock.mockReset();
    resourcesTesting.reset();
  });

  it("DN-API-1: calls client.GET with correct path key and date param", async () => {
    getMock.mockResolvedValue({ data: fakeNote, error: undefined });

    const result = await openTodayDailyNote(TODAY);

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith("/daily-notes/{date}", {
      params: { path: { date: TODAY } },
    });
    expect(result.id).toBe(fakeNote.id);
    expect(result.path).toBe(fakeNote.path);
  });

  it("DN-API-2: returns NoteDetail with content field intact", async () => {
    getMock.mockResolvedValue({ data: fakeNote, error: undefined });

    const result = await openTodayDailyNote(TODAY);

    expect(result.content).toBe(fakeNote.content);
    expect(result.updated_at).toBe(fakeNote.updated_at);
  });

  it("DN-API-3: throws when client returns an error object", async () => {
    const fakeError = { code: "not_found", message: "handler error" };
    getMock.mockResolvedValue({ data: undefined, error: fakeError });

    await expect(openTodayDailyNote(TODAY)).rejects.toThrow(
      "openTodayDailyNote:",
    );
  });

  it("DN-API-4: throws when data is undefined (empty response)", async () => {
    getMock.mockResolvedValue({ data: undefined, error: undefined });

    await expect(openTodayDailyNote(TODAY)).rejects.toThrow(
      "openTodayDailyNote: empty response",
    );
  });

  it("DN-API-5: two concurrent calls for the same date coalesce into one client.GET (D-05)", async () => {
    let resolveGet!: (v: { data: typeof fakeNote; error: undefined }) => void;
    getMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGet = resolve;
      }),
    );

    const call1 = openTodayDailyNote(TODAY);
    const call2 = openTodayDailyNote(TODAY);

    resolveGet({ data: fakeNote, error: undefined });

    const [result1, result2] = await Promise.all([call1, call2]);

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(result1.id).toBe(fakeNote.id);
    expect(result2.id).toBe(fakeNote.id);
  });

  it("DN-API-6: sequential calls (no overlap) each issue their own client.GET — pass-through is never cached", async () => {
    getMock.mockResolvedValue({ data: fakeNote, error: undefined });

    await openTodayDailyNote(TODAY);
    await openTodayDailyNote(TODAY);

    expect(getMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * noteBufferController unit tests — proves the per-note singleton contract,
 * save/debounce coalescing, and once-per-note WebSocket reconciliation in
 * isolation (no React tree, no DOM).
 *
 * Mocking strategy mirrors EditorPane.test.tsx: notesApi/treeApi are the
 * network seam, mocked at the module boundary; useTagBrowser's dispatchTagEvent
 * is a plain function (no React needed) so it is left un-mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./notesApi", () => ({
  getNote: vi.fn(),
  updateNote: vi.fn(),
}));

vi.mock("./treeApi", () => ({
  postNoteMove: vi.fn(),
}));

import { getNote, updateNote } from "./notesApi";
import { postNoteMove } from "./treeApi";
import {
  __resetAllControllersForTest,
  getOrCreateController,
  releaseController,
} from "./noteBufferController";

const getNoteMock = vi.mocked(getNote);
const updateNoteMock = vi.mocked(updateNote);
const postNoteMoveMock = vi.mocked(postNoteMove);

type UpdateReturn = Awaited<ReturnType<typeof updateNote>>;
type GetReturn = Awaited<ReturnType<typeof getNote>>;

function okUpdate(updatedAt = "2026-01-01T00:00:00Z"): UpdateReturn {
  return {
    data: { id: "n1", path: "n1.md", updated_at: updatedAt, content: "" },
    error: undefined,
    response: new Response(),
  } as UpdateReturn;
}

function okGet(content: string, path = "n1.md"): GetReturn {
  return {
    data: {
      id: "n1",
      path,
      content,
      updated_at: "2026-01-01T00:00:00Z",
    },
    error: undefined,
    response: new Response(),
  } as GetReturn;
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetAllControllersForTest();
  getNoteMock.mockReset();
  updateNoteMock.mockReset();
  postNoteMoveMock.mockReset();
  updateNoteMock.mockResolvedValue(okUpdate());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getOrCreateController", () => {
  it("returns the SAME instance for repeated calls with one noteId", () => {
    const a = getOrCreateController("note-1");
    const b = getOrCreateController("note-1");
    expect(a).toBe(b);
  });

  it("returns DIFFERENT instances for different noteIds", () => {
    const a = getOrCreateController("note-1");
    const b = getOrCreateController("note-2");
    expect(a).not.toBe(b);
  });
});

describe("handleEditorChange debounce + coalescing", () => {
  it("rapid edits produce exactly one save after the debounce settles", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    c.handleEditorChange("a");
    c.handleEditorChange("ab");
    c.handleEditorChange("abc");

    await vi.advanceTimersByTimeAsync(2000);

    expect(updateNoteMock).toHaveBeenCalledTimes(1);
    expect(updateNoteMock).toHaveBeenCalledWith("note-1", "abc");
  });

  it("an edit arriving while a save is in flight produces exactly one trailing save", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    const pending: { resolve: (() => void) | null } = { resolve: null };
    updateNoteMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          pending.resolve = () => resolve(okUpdate());
        }),
    );

    c.handleEditorChange("first-edit");
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateNoteMock).toHaveBeenCalledTimes(1);

    // Content changes while the first save is still in flight.
    c.handleEditorChange("second-edit");
    await vi.advanceTimersByTimeAsync(2000);
    // The debounced call for "second-edit" coalesces onto the trailing
    // save queue rather than firing a second concurrent updateNote call.
    expect(updateNoteMock).toHaveBeenCalledTimes(1);

    updateNoteMock.mockResolvedValueOnce(okUpdate("2026-01-02T00:00:00Z"));
    pending.resolve?.();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(updateNoteMock).toHaveBeenCalledTimes(2);
    expect(updateNoteMock).toHaveBeenLastCalledWith("note-1", "second-edit");
  });

  it("handleEditorChange called twice with IDENTICAL content does not double-schedule or double-save", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    c.handleEditorChange("same-text");
    c.handleEditorChange("same-text");

    await vi.advanceTimersByTimeAsync(2000);

    expect(updateNoteMock).toHaveBeenCalledTimes(1);
  });
});

describe("flush", () => {
  it("resolves after the pending save completes", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    c.handleEditorChange("edited");
    const flushPromise = c.flush();
    await vi.runOnlyPendingTimersAsync();
    await flushPromise;

    expect(updateNoteMock).toHaveBeenCalledTimes(1);
    expect(updateNoteMock).toHaveBeenCalledWith("note-1", "edited");
  });

  it("is a no-op when there are no pending edits", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    await c.flush();
    expect(updateNoteMock).not.toHaveBeenCalled();
  });
});

describe("release lifecycle (flush-before-release, T-25-04-Loss)", () => {
  it("flushes a pending edit before releaseController resolves (no data loss)", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    // No timer advance — flush() must save immediately, cancelling any
    // still-pending debounce, rather than dropping the edit on teardown.
    c.handleEditorChange("edited-before-close");
    await releaseController("note-1");

    expect(updateNoteMock).toHaveBeenCalledWith("note-1", "edited-before-close");
  });

  it("does not throw when the final flush fails, and still removes the controller", async () => {
    updateNoteMock.mockResolvedValueOnce({
      data: undefined,
      error: { message: "save failed" },
      response: new Response(null, { status: 500 }),
    } as UpdateReturn);

    const c = getOrCreateController("note-2", 2000);
    c.hydrate("initial", "n2.md");
    c.handleEditorChange("edited");

    await expect(releaseController("note-2")).resolves.toBeUndefined();

    // Cross-instance guard: once released, a fresh getOrCreateController
    // call for the same id must never reuse the old (torn-down) instance —
    // the old instance's abandoned state can never leak into the new one.
    const fresh = getOrCreateController("note-2", 2000);
    expect(fresh).not.toBe(c);
    expect(fresh.getContent()).toBe("");
  });
});

describe("onNoteUpdated — once-per-note WS reconciliation", () => {
  it("silently adopts server content when there is no pending local edit", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    getNoteMock.mockResolvedValueOnce(okGet("server content"));

    c.onNoteUpdated({ id: "note-1", path: "n1.md", updated_at: "2026-01-01T00:00:00Z" });
    await Promise.resolve();
    await Promise.resolve();

    expect(c.getContent()).toBe("server content");
    expect(c.getConflict()).toBeNull();
  });

  it("surfaces a single conflict state when there IS a pending local edit", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    c.handleEditorChange("unsaved local edit");

    c.onNoteUpdated({ id: "note-1", path: "n1.md", updated_at: "2026-01-02T00:00:00Z" });
    await Promise.resolve();

    expect(getNoteMock).not.toHaveBeenCalled();
    expect(c.getConflict()).toEqual({
      visible: true,
      currentUpdatedAt: "2026-01-02T00:00:00Z",
    });
    // Local content is preserved, not clobbered by the server event.
    expect(c.getContent()).toBe("unsaved local edit");
  });

  it("one onNoteUpdated call yields exactly one content/conflict transition (not N)", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    getNoteMock.mockResolvedValueOnce(okGet("server content v2"));

    const seen: Array<string> = [];
    const unsubscribe = c.subscribe(() => {
      seen.push(c.getContent());
    });

    c.onNoteUpdated({ id: "note-1", path: "n1.md", updated_at: "2026-01-01T00:00:00Z" });
    await Promise.resolve();
    await Promise.resolve();

    unsubscribe();

    // Exactly one notification carries the new server content — not one
    // per pane/subscriber, and not fired multiple times for a single event.
    expect(seen.filter((c2) => c2 === "server content v2")).toHaveLength(1);
  });

  it("ignores payloads for a different noteId", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    c.onNoteUpdated({ id: "some-other-note", path: "other.md", updated_at: "2026-01-01T00:00:00Z" });
    await Promise.resolve();

    expect(getNoteMock).not.toHaveBeenCalled();
    expect(c.getConflict()).toBeNull();
    expect(c.getContent()).toBe("initial");
  });
});

describe("onNoteDeleted", () => {
  it("marks the buffer deleted, once, for the matching noteId", () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    c.onNoteDeleted({ id: "note-1", path: "n1.md" });

    expect(c.getDeleted()).toEqual({ visible: true, deletedPath: "n1.md" });
  });

  it("ignores payloads for a different noteId", () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    c.onNoteDeleted({ id: "some-other-note", path: "other.md" });

    expect(c.getDeleted()).toBeNull();
  });
});

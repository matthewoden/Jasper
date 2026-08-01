/**
 * noteBufferController unit tests — proves the per-note singleton contract,
 * save/debounce coalescing, and once-per-note WebSocket reconciliation in
 * isolation (no React tree, no DOM).
 *
 * Mocking strategy mirrors EditorPane.test.tsx: notesApi/treeApi are the
 * network seam, mocked at the module boundary; the resource-layer event
 * bus's publish() is a plain function (no React needed) so it is left
 * un-mocked.
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

  it("WR-02 regression (25-REVIEW.md): a silent adopt re-seeds lastH1Sent/lastNotePath so the NEXT edit does not trigger a spurious rename", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("# Original Title\n\nbody", "original-title.md");

    // Another session renamed the note via its own H1 edit (H1<->filename
    // binding already applied server-side). This controller has no pending
    // local edit, so onNoteUpdated silently adopts the fresh server content.
    getNoteMock.mockResolvedValueOnce(
      okGet("# Renamed Title\n\nbody", "renamed-title.md"),
    );
    c.onNoteUpdated({
      id: "note-1",
      path: "renamed-title.md",
      updated_at: "2026-01-02T00:00:00Z",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(c.getContent()).toBe("# Renamed Title\n\nbody");
    expect(c.getNotePath()).toBe("renamed-title.md");

    // A later, UNRELATED edit keeping the SAME (already-adopted) H1 must not
    // recompute a rename. Before the fix, lastH1Sent still held the STALE
    // "Original Title" value from hydrate(), so this save would see
    // currentH1 !== lastH1Sent and fire an unwanted postNoteMove — composed
    // against the (also stale) pre-adopt lastNotePath, risking a 409 against
    // the path the other session already renamed to.
    c.handleEditorChange("# Renamed Title\n\nbody edited");
    await c.flush();

    expect(postNoteMoveMock).not.toHaveBeenCalled();
    expect(updateNoteMock).toHaveBeenCalledWith(
      "note-1",
      "# Renamed Title\n\nbody edited",
    );
  });
});

describe("subscribeContentReplaced (Plan 05: uncontrolled CM6 ref push on silent WS adopt)", () => {
  it("fires with the new content right after a silent onNoteUpdated adopt", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");
    getNoteMock.mockResolvedValueOnce(okGet("server content"));

    const onReplaced = vi.fn();
    c.subscribeContentReplaced(onReplaced);

    c.onNoteUpdated({ id: "note-1", path: "n1.md", updated_at: "2026-01-01T00:00:00Z" });
    await Promise.resolve();
    await Promise.resolve();

    expect(onReplaced).toHaveBeenCalledWith("server content");
  });

  it("does not fire when a pending local edit forces the conflict path instead", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");
    c.handleEditorChange("unsaved");

    const onReplaced = vi.fn();
    c.subscribeContentReplaced(onReplaced);

    c.onNoteUpdated({ id: "note-1", path: "n1.md", updated_at: "2026-01-01T00:00:00Z" });
    await Promise.resolve();

    expect(onReplaced).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further notifications", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");
    getNoteMock.mockResolvedValueOnce(okGet("server content"));

    const onReplaced = vi.fn();
    const unsubscribe = c.subscribeContentReplaced(onReplaced);
    unsubscribe();

    c.onNoteUpdated({ id: "note-1", path: "n1.md", updated_at: "2026-01-01T00:00:00Z" });
    await Promise.resolve();
    await Promise.resolve();

    expect(onReplaced).not.toHaveBeenCalled();
  });
});

describe("setNotePath (CR-01/CR-02: live tree path overrides the load-time seed)", () => {
  it("a later setNotePath call is used as the rename comparator's current side", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("# Original\n\nbody", "untitled.md");
    c.setNotePath("projects/manual.md");
    postNoteMoveMock.mockResolvedValue({
      data: { id: "note-1", path: "projects/renamed.md", title: "renamed", updated_at: "2026-01-01T00:00:00Z" },
      error: undefined,
      response: new Response(),
    } as Awaited<ReturnType<typeof postNoteMove>>);

    c.handleEditorChange("# renamed\n\nbody");
    await vi.advanceTimersByTimeAsync(2000);

    expect(postNoteMoveMock).toHaveBeenCalledWith("note-1", "projects/renamed.md");
  });

  it("does not touch content/saveState/conflict", () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");
    c.setNotePath("elsewhere.md");

    expect(c.getContent()).toBe("initial");
    expect(c.getSaveState()).toEqual({ status: "idle" });
    expect(c.getConflict()).toBeNull();
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

describe("setSaveGate (Plan 05: reindex/connectionStatus gating reintroduced at the call site)", () => {
  it("a closed gate blocks a debounced save without transitioning saveState", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");
    c.setSaveGate(() => false);

    c.handleEditorChange("edited");
    await vi.advanceTimersByTimeAsync(2000);

    expect(updateNoteMock).not.toHaveBeenCalled();
    expect(c.getSaveState()).toEqual({ status: "idle" });
  });

  it("a closed gate blocks flush() and rejects it (TAB-13 close-flush parity)", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");
    c.setSaveGate(() => false);

    c.handleEditorChange("edited");
    await expect(c.flush()).rejects.toThrow("flush failed");
    expect(updateNoteMock).not.toHaveBeenCalled();
  });

  it("re-opening the gate lets the NEXT save attempt through", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");
    let open = false;
    c.setSaveGate(() => open);

    c.handleEditorChange("edited");
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateNoteMock).not.toHaveBeenCalled();

    open = true;
    c.handleEditorChange("edited again");
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateNoteMock).toHaveBeenCalledTimes(1);
    expect(updateNoteMock).toHaveBeenCalledWith("note-1", "edited again");
  });

  it("WR-03 regression (25-REVIEW.md): setSaveGate is multi-owner — one pane's unregister must not clear another pane's gate", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    // Two panes on the SAME note each register their own gate — mirrors two
    // EditorPanes showing note-1 in a split layout.
    const unregisterPaneA = c.setSaveGate(() => true); // pane A: open/connected
    const unregisterPaneB = c.setSaveGate(() => false); // pane B: e.g. reindexing

    c.handleEditorChange("edited");
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateNoteMock).not.toHaveBeenCalled(); // pane B's gate still blocks

    // Pane A unmounts (e.g. its tab closes) — before the WR-03 fix, a
    // single-slot `setSaveGate(null)` here would have cleared pane B's gate
    // too, since both panes shared one setter. With multi-owner gates, only
    // pane A's OWN predicate is removed.
    unregisterPaneA();

    c.handleEditorChange("edited again");
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateNoteMock).not.toHaveBeenCalled(); // still blocked by pane B

    // Pane B unmounts too — no gates remain, so the next save proceeds.
    unregisterPaneB();
    c.handleEditorChange("edited once more");
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateNoteMock).toHaveBeenCalledTimes(1);
    expect(updateNoteMock).toHaveBeenCalledWith("note-1", "edited once more");
  });
});

describe("discardPendingEdit (WR-02: no cross-note PUT on fallback-pane note switch)", () => {
  it("cancels a pending debounced save without calling updateNote", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    c.handleEditorChange("edited");
    c.discardPendingEdit();
    await vi.advanceTimersByTimeAsync(2000);

    expect(updateNoteMock).not.toHaveBeenCalled();
  });

  it("resets the pending-edit flag so a subsequent flush() is a no-op", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    c.handleEditorChange("edited");
    c.discardPendingEdit();
    await c.flush();

    expect(updateNoteMock).not.toHaveBeenCalled();
  });
});

describe("setAutosaveMs (WR-04: async config arriving after mount)", () => {
  it("a later setAutosaveMs call drives the NEXT debounce, not the construction-time value", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");
    c.setAutosaveMs(500);

    c.handleEditorChange("edited");
    await vi.advanceTimersByTimeAsync(500);

    expect(updateNoteMock).toHaveBeenCalledTimes(1);
    expect(updateNoteMock).toHaveBeenCalledWith("note-1", "edited");
  });
});

describe("reportSaveFailed (Save-anyway direct-API failure reporting)", () => {
  it("transitions saveState to error without attempting a network save", () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("initial", "n1.md");

    c.reportSaveFailed("disk full");

    expect(c.getSaveState()).toEqual({ status: "error", error: "disk full" });
    expect(updateNoteMock).not.toHaveBeenCalled();
  });
});

describe("subscribeRenamed (Plan 05: EditorPane refreshTree() reintroduction)", () => {
  it("fires with the new path right after a successful H1-driven rename", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("# Original\n\nbody", "original.md");
    postNoteMoveMock.mockResolvedValue({
      data: { id: "note-1", path: "new-title.md", title: "new-title", updated_at: "2026-01-01T00:00:00Z" },
      error: undefined,
      response: new Response(),
    } as Awaited<ReturnType<typeof postNoteMove>>);

    const onRenamed = vi.fn();
    c.subscribeRenamed(onRenamed);

    c.handleEditorChange("# New Title\n\nbody");
    await vi.advanceTimersByTimeAsync(2000);
    expect(onRenamed).toHaveBeenCalledWith("new-title.md");
  });

  it("does not fire when no rename occurs (body-only edit)", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("# Title\n\nbody", "title.md");

    const onRenamed = vi.fn();
    c.subscribeRenamed(onRenamed);

    c.handleEditorChange("# Title\n\nbody edited");
    await vi.advanceTimersByTimeAsync(2000);

    expect(onRenamed).not.toHaveBeenCalled();
    expect(postNoteMoveMock).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further notifications", async () => {
    const c = getOrCreateController("note-1", 2000);
    c.hydrate("# Original\n\nbody", "original.md");
    postNoteMoveMock.mockResolvedValue({
      data: { id: "note-1", path: "new-title.md", title: "new-title", updated_at: "2026-01-01T00:00:00Z" },
      error: undefined,
      response: new Response(),
    } as Awaited<ReturnType<typeof postNoteMove>>);

    const onRenamed = vi.fn();
    const unsubscribe = c.subscribeRenamed(onRenamed);
    unsubscribe();

    c.handleEditorChange("# New Title\n\nbody");
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateNoteMock).toHaveBeenCalled();

    expect(onRenamed).not.toHaveBeenCalled();
  });
});

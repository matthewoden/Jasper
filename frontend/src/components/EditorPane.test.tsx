/**
 * EditorPane integration tests. Uses fake timers to drive the 2s debounce and
 * the 2s saved-sticky window deterministically.
 *
 * Mocking strategy: notesApi is the single seam — components never import the
 * raw client, so mocking notesApi is sufficient and proves the API-03 contract
 * (everything routes through the typed wrappers).
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mocked at module-load time so the EditorPane import below picks up the
// mocked exports. vi.mock is hoisted above the imports by Vitest.
vi.mock("../lib/notesApi", () => ({
  ScratchpadUUID: "00000000-0000-4000-a000-000000000001",
  getNote: vi.fn(),
  updateNote: vi.fn(),
}));

// Plan 03-22 (Gap R2-6) — performSave dispatches a move BEFORE updateNote
// when the H1 changes. The H1 detection branch routes through treeApi's
// postNoteMove wrapper; mock it here at module-load time so the EditorPane
// import below picks up the mock.
vi.mock("../lib/treeApi", () => ({
  postNoteMove: vi.fn(),
}));

import { ScratchpadUUID, getNote, updateNote } from "../lib/notesApi";
import { postNoteMove } from "../lib/treeApi";
import {
  AUTOSAVE_DEBOUNCE_MS,
  EditorPane,
  SAVED_STICKY_MS,
} from "./EditorPane";

const getNoteMock = vi.mocked(getNote);
const updateNoteMock = vi.mocked(updateNote);
const postNoteMoveMock = vi.mocked(postNoteMove);

// Shapes that match the openapi-fetch return contract closely enough for the
// component's destructure (`{ data, error }`). The exact `response` field is
// not consulted, but openapi-fetch returns it on success.
type GetReturn = Awaited<ReturnType<typeof getNote>>;
type PutReturn = Awaited<ReturnType<typeof updateNote>>;

function okGet(content: string): GetReturn {
  return {
    data: {
      id: ScratchpadUUID,
      path: "scratchpad.md",
      content,
      updated_at: "2025-01-01T00:00:00Z",
    },
    error: undefined,
    response: new Response(),
  } as GetReturn;
}

function okPut(): PutReturn {
  return {
    data: {
      id: ScratchpadUUID,
      path: "scratchpad.md",
      updated_at: "2025-01-01T00:00:00Z",
    },
    error: undefined,
    response: new Response(),
  } as PutReturn;
}

function errGet(message: string): GetReturn {
  return {
    data: undefined,
    error: { code: "boom", message },
    response: new Response(),
  } as unknown as GetReturn;
}

function errPut(message: string): PutReturn {
  return {
    data: undefined,
    error: { code: "io", message },
    response: new Response(),
  } as unknown as PutReturn;
}

beforeEach(() => {
  getNoteMock.mockReset();
  updateNoteMock.mockReset();
  postNoteMoveMock.mockReset();
  // shouldAdvanceTime: true keeps real-time microtasks flowing so
  // @testing-library's waitFor() retries make progress; manual
  // advanceTimersByTimeAsync calls still drive the 2s debounce + sticky window.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flushMicrotasks() {
  // Give pending microtasks (the load `await`, the focus Promise.resolve)
  // a chance to settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("<EditorPane />", () => {
  it("E1: shows Loading… while GET is in flight, then loads content + enables + focuses", async () => {
    let resolveGet: (v: GetReturn) => void = () => {};
    getNoteMock.mockReturnValue(
      new Promise<GetReturn>((r) => {
        resolveGet = r;
      }) as ReturnType<typeof getNote>,
    );

    render(<EditorPane noteId={ScratchpadUUID} />);

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    expect(textarea).toBeDisabled();
    expect(textarea).toHaveAttribute("placeholder", "Loading…");

    await act(async () => {
      resolveGet(okGet("abc"));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(textarea).not.toBeDisabled());
    expect(textarea.value).toBe("abc");
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it("E2: GET error renders the locked failure copy + leaves textarea disabled", async () => {
    getNoteMock.mockResolvedValue(errGet("broken"));

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    expect(
      screen.getByText(
        "Could not load note. Check that the server is running, then refresh the page.",
      ),
    ).toBeInTheDocument();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    expect(textarea).toBeDisabled();
  });

  it("E3: typing → 2s debounce → saving → saved → ~2s later → idle", async () => {
    getNoteMock.mockResolvedValue(okGet("hello"));
    updateNoteMock.mockResolvedValue(okPut());

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    fireEvent.change(textarea, { target: { value: "hello world" } });

    // Idle for the first 2s (debounce window).
    expect(screen.getByRole("status")).not.toHaveAttribute("title");

    // Advance the debounce timer; saving fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });

    expect(updateNoteMock).toHaveBeenCalledWith(
      ScratchpadUUID,
      "hello world",
    );

    await flushMicrotasks();
    expect(screen.getByRole("status")).toHaveAttribute(
      "title",
      expect.stringMatching(/^Saved at \d{2}:\d{2}:\d{2}$/),
    );

    // Saved-sticky window expires → idle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVED_STICKY_MS + 10);
    });
    expect(screen.getByRole("status")).not.toHaveAttribute("title");
  });

  it("E4: Cmd+S immediately saves (collapses pending debounce) and preventDefaults the event", async () => {
    getNoteMock.mockResolvedValue(okGet("hi"));
    updateNoteMock.mockResolvedValue(okPut());

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    fireEvent.change(textarea, { target: { value: "edited" } });

    // Don't wait the full debounce — fire Cmd+S immediately.
    const event = new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");

    await act(async () => {
      textarea.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(updateNoteMock).toHaveBeenCalledTimes(1);
    expect(updateNoteMock).toHaveBeenCalledWith(ScratchpadUUID, "edited");

    // Even if 2s passes now, the debounce was cleared — no second PUT.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 100);
    });
    expect(updateNoteMock).toHaveBeenCalledTimes(1);
  });

  it("E4b: Ctrl+S also triggers an immediate save (non-Mac platforms)", async () => {
    getNoteMock.mockResolvedValue(okGet("hi"));
    updateNoteMock.mockResolvedValue(okPut());

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    fireEvent.change(textarea, { target: { value: "x" } });
    fireEvent.keyDown(textarea, { key: "s", ctrlKey: true });

    await flushMicrotasks();
    expect(updateNoteMock).toHaveBeenCalledTimes(1);
  });

  it("E5: PUT failure → error state; next edit → saving (recovery)", async () => {
    getNoteMock.mockResolvedValue(okGet("a"));
    updateNoteMock.mockResolvedValueOnce(errPut("disk full"));

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    fireEvent.change(textarea, { target: { value: "boom" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    await flushMicrotasks();

    expect(screen.getByRole("status")).toHaveAttribute(
      "title",
      "Save failed — your edit is still in the editor. Press ⌘S to retry.",
    );

    // Recovery: next edit + debounce → saving again.
    updateNoteMock.mockResolvedValue(okPut());
    fireEvent.change(textarea, { target: { value: "boom!" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    await flushMicrotasks();

    expect(updateNoteMock).toHaveBeenCalledTimes(2);
  });

  it("E6: in-flight coalescing — many edits during one in-flight save → exactly ONE trailing PUT", async () => {
    getNoteMock.mockResolvedValue(okGet("start"));

    let resolveFirst: (v: PutReturn) => void = () => {};
    let resolveSecond: (v: PutReturn) => void = () => {};
    updateNoteMock
      .mockImplementationOnce(
        () =>
          new Promise<PutReturn>((r) => {
            resolveFirst = r;
          }) as ReturnType<typeof updateNote>,
      )
      .mockImplementationOnce(
        () =>
          new Promise<PutReturn>((r) => {
            resolveSecond = r;
          }) as ReturnType<typeof updateNote>,
      );

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    // First PUT kicks off via debounce.
    fireEvent.change(textarea, { target: { value: "edit1" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    expect(updateNoteMock).toHaveBeenCalledTimes(1);

    // While the first PUT is in flight, fire many more edits + saves. They
    // should all collapse into exactly ONE queued trailing save.
    fireEvent.change(textarea, { target: { value: "edit2" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    fireEvent.change(textarea, { target: { value: "edit3" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    fireEvent.keyDown(textarea, { key: "s", metaKey: true });
    fireEvent.keyDown(textarea, { key: "s", metaKey: true });
    await flushMicrotasks();

    // Still only one PUT — the rest are queued (collapsed).
    expect(updateNoteMock).toHaveBeenCalledTimes(1);

    // Resolve the first PUT; the queued trailing save fires with the freshest
    // content ("edit3").
    await act(async () => {
      resolveFirst(okPut());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateNoteMock).toHaveBeenCalledTimes(2);
    expect(updateNoteMock).toHaveBeenLastCalledWith(
      ScratchpadUUID,
      "edit3",
    );

    // Resolve the second PUT so we don't leak a pending promise.
    await act(async () => {
      resolveSecond(okPut());
      await Promise.resolve();
    });
  });

  it("E7: Cmd+S during the saved-sticky window immediately re-saves", async () => {
    getNoteMock.mockResolvedValue(okGet("a"));
    updateNoteMock.mockResolvedValue(okPut());

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    fireEvent.change(textarea, { target: { value: "x" } });
    fireEvent.keyDown(textarea, { key: "s", metaKey: true });
    await flushMicrotasks();
    expect(updateNoteMock).toHaveBeenCalledTimes(1);

    // We're in saved state now (within the sticky window). Cmd+S again.
    fireEvent.keyDown(textarea, { key: "s", metaKey: true });
    await flushMicrotasks();
    expect(updateNoteMock).toHaveBeenCalledTimes(2);
  });

  it("ignores keys other than s, and s without a modifier", async () => {
    getNoteMock.mockResolvedValue(okGet("a"));
    updateNoteMock.mockResolvedValue(okPut());

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    fireEvent.keyDown(textarea, { key: "a", metaKey: true });
    fireEvent.keyDown(textarea, { key: "s" }); // no modifier
    await flushMicrotasks();
    expect(updateNoteMock).not.toHaveBeenCalled();
  });

  it("Phase 2: when reindexing=true, textarea is disabled with the locked placeholder", async () => {
    getNoteMock.mockResolvedValue(okGet("a"));
    updateNoteMock.mockResolvedValue(okPut());

    render(<EditorPane noteId={ScratchpadUUID} reindexing={true} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    expect(textarea).toBeDisabled();
    expect(textarea.placeholder).toBe("Index is rebuilding…");
  });

  it("TestEditorPane_NullNoteId_RendersPlaceholder", async () => {
    render(<EditorPane noteId={null} />);
    await flushMicrotasks();
    expect(
      screen.getByText("Select a note to start editing."),
    ).toBeInTheDocument();
    // No textarea / no API call when noteId is null.
    expect(screen.queryByLabelText("Note content")).toBeNull();
    expect(getNoteMock).not.toHaveBeenCalled();
  });

  it("TestEditorPane_NoteIdChange_TriggersReload", async () => {
    getNoteMock.mockImplementation((id: string) =>
      Promise.resolve(okGet(`content for ${id}`)),
    );
    updateNoteMock.mockResolvedValue(okPut());

    const { rerender } = render(
      <EditorPane noteId="00000000-0000-4000-a000-000000000001" />,
    );
    await flushMicrotasks();
    let textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    // Re-render with a different noteId; the load effect should re-fire
    // and getNote should be called with the new id.
    rerender(<EditorPane noteId="other-id" />);
    await flushMicrotasks();
    textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());
    expect(getNoteMock).toHaveBeenCalledWith("other-id");
  });
});

describe("generic load-error copy (Gap 6b)", () => {
  it("LOAD_ERROR_COPY does not mention scratchpad", async () => {
    getNoteMock.mockResolvedValue(errGet("boom"));

    render(<EditorPane noteId="any-uuid" />);
    const alert = await screen.findByRole("alert");

    expect(alert.textContent ?? "").toMatch(/Could not load note/);
    expect(alert.textContent ?? "").not.toMatch(/scratchpad/i);
    expect(alert.textContent ?? "").toMatch(
      /Check that the server is running/,
    );
  });

  it("textarea aria-label is generic 'Note content', not 'Scratchpad note content'", async () => {
    getNoteMock.mockResolvedValue(okGet("hi"));

    render(<EditorPane noteId="any-uuid" />);
    await flushMicrotasks();

    const textarea = (await screen.findByRole(
      "textbox",
    )) as HTMLTextAreaElement;
    expect(textarea.getAttribute("aria-label")).toBe("Note content");
  });
});

// ────────────────────────────────────────────────────────────────────
// Plan 03-22 (Gap R2-6) — H1 → filename binding (Direction A).
//
// performSave detects an H1 delta vs lastH1Sent and dispatches
// moveNote BEFORE updateNote. Loop prevention via isRenameInProgress.
// Sanitization rejects illegal H1s with an inline editor banner;
// case_collision aborts the save with a different banner.
// ────────────────────────────────────────────────────────────────────

type MoveReturn = Awaited<ReturnType<typeof postNoteMove>>;

function okMove(path: string): MoveReturn {
  return {
    data: {
      id: ScratchpadUUID,
      path,
      title: "title",
      updated_at: "2025-01-01T00:00:00Z",
    },
  } as MoveReturn;
}

function errMove(code: string, message: string, status = 409): MoveReturn {
  return {
    error: { code, message, status },
  } as MoveReturn;
}

describe("<EditorPane /> — Plan 03-22 H1→filename binding", () => {
  it("R2-6 T1: H1 change → moveNote fires BEFORE updateNote with the sanitized basename", async () => {
    getNoteMock.mockResolvedValue(okGet("# Original\n\nbody"));
    postNoteMoveMock.mockResolvedValue(okMove("new title.md"));
    updateNoteMock.mockResolvedValue(okPut());

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    fireEvent.change(textarea, {
      target: { value: "# new title\n\nbody" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    await flushMicrotasks();

    // moveNote called with sanitized basename + .md (root parent → no slash).
    expect(postNoteMoveMock).toHaveBeenCalledTimes(1);
    expect(postNoteMoveMock).toHaveBeenCalledWith(
      ScratchpadUUID,
      "new title.md",
    );
    // updateNote called once after moveNote with the new content.
    expect(updateNoteMock).toHaveBeenCalledTimes(1);
    expect(updateNoteMock).toHaveBeenCalledWith(
      ScratchpadUUID,
      "# new title\n\nbody",
    );
    // Order: moveNote BEFORE updateNote (the move semantics: collision
    // must abort cleanly before content commits).
    expect(postNoteMoveMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateNoteMock.mock.invocationCallOrder[0]!,
    );
  });

  it("R2-6 T2: body-only change (H1 unchanged) → ZERO moveNote calls; one updateNote", async () => {
    getNoteMock.mockResolvedValue(okGet("# Title\n\nbody"));
    updateNoteMock.mockResolvedValue(okPut());

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    fireEvent.change(textarea, {
      target: { value: "# Title\n\nbody changed" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    await flushMicrotasks();

    expect(postNoteMoveMock).not.toHaveBeenCalled();
    expect(updateNoteMock).toHaveBeenCalledTimes(1);
    expect(updateNoteMock).toHaveBeenCalledWith(
      ScratchpadUUID,
      "# Title\n\nbody changed",
    );
  });

  it("R2-6 T3: H1 with illegal char (e.g. '/') → no moveNote; updateNote still runs; banner surfaces", async () => {
    getNoteMock.mockResolvedValue(okGet("# Original\n\nbody"));
    updateNoteMock.mockResolvedValue(okPut());

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    fireEvent.change(textarea, {
      target: { value: "# my/note\n\nbody" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    await flushMicrotasks();

    expect(postNoteMoveMock).not.toHaveBeenCalled();
    // Content save still goes through (soft error — research §2.3
    // recommended treatment).
    expect(updateNoteMock).toHaveBeenCalledTimes(1);
    expect(updateNoteMock).toHaveBeenCalledWith(
      ScratchpadUUID,
      "# my/note\n\nbody",
    );
    // Inline banner mentions filename / characters language.
    expect(
      screen.getByText(/aren't allowed in filenames/i),
    ).toBeInTheDocument();
  });

  it("R2-6 T4: in-flight rename loop guard — concurrent H1-change saves do NOT dispatch a second moveNote", async () => {
    getNoteMock.mockResolvedValue(okGet("# Original\n\nbody"));
    let resolveMove: (v: MoveReturn) => void = () => {};
    postNoteMoveMock.mockImplementation(
      () =>
        new Promise<MoveReturn>((r) => {
          resolveMove = r;
        }) as ReturnType<typeof postNoteMove>,
    );
    updateNoteMock.mockResolvedValue(okPut());

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    // First H1 change → first moveNote dispatched (in flight).
    fireEvent.change(textarea, {
      target: { value: "# first\n\nbody" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    await flushMicrotasks();
    expect(postNoteMoveMock).toHaveBeenCalledTimes(1);

    // Second H1 change while the first move is still in flight. The
    // existing autosave coalesces saves via inFlight; isRenameInProgress
    // separately guards the H1 detector. No second moveNote should
    // fire while the first is unresolved.
    fireEvent.change(textarea, {
      target: { value: "# second\n\nbody" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    fireEvent.keyDown(textarea, { key: "s", metaKey: true });
    await flushMicrotasks();

    // Still only one moveNote call.
    expect(postNoteMoveMock).toHaveBeenCalledTimes(1);

    // Resolve the in-flight move; the trailing autosave fires.
    await act(async () => {
      resolveMove(okMove("first.md"));
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("R2-6 T5: case_collision on moveNote → updateNote does NOT run; banner mentions taken filename", async () => {
    getNoteMock.mockResolvedValue(okGet("# Original\n\nbody"));
    postNoteMoveMock.mockResolvedValue(
      errMove("case_collision", "taken.md", 409),
    );
    updateNoteMock.mockResolvedValue(okPut());

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    fireEvent.change(textarea, {
      target: { value: "# taken\n\nbody" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    await flushMicrotasks();

    expect(postNoteMoveMock).toHaveBeenCalledTimes(1);
    // Bail early — content save does NOT run on rename failure.
    expect(updateNoteMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(/that filename is already taken/i),
    ).toBeInTheDocument();
  });

  it("R2-6 T6: H1 erased to empty → no moveNote; updateNote runs normally", async () => {
    getNoteMock.mockResolvedValue(okGet("# Original\n\nbody"));
    updateNoteMock.mockResolvedValue(okPut());

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    // User erases the heading line entirely.
    fireEvent.change(textarea, {
      target: { value: "\n\nbody only" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    await flushMicrotasks();

    // Empty H1 (extractH1FromContent returns null) is a no-op — the
    // file keeps its current filename until the user types an H1.
    // Research §2.1: "filename does NOT auto-bind when H1 is empty."
    expect(postNoteMoveMock).not.toHaveBeenCalled();
    expect(updateNoteMock).toHaveBeenCalledTimes(1);
  });

  it("R2-6 T7: pre-existing autosave behavior stays green when the H1 hook is dormant", async () => {
    // Repeat E3's debounce → saving → saved → idle path with the new
    // hook installed but no H1 change. The new branch must not perturb
    // the SaveIndicator state machine or the timer cadence.
    getNoteMock.mockResolvedValue(okGet("# Title\n\nhello"));
    updateNoteMock.mockResolvedValue(okPut());

    render(<EditorPane noteId={ScratchpadUUID} />);
    await flushMicrotasks();

    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).not.toBeDisabled());

    fireEvent.change(textarea, {
      target: { value: "# Title\n\nhello world" },
    });

    expect(screen.getByRole("status")).not.toHaveAttribute("title");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    await flushMicrotasks();

    expect(postNoteMoveMock).not.toHaveBeenCalled();
    expect(updateNoteMock).toHaveBeenCalledWith(
      ScratchpadUUID,
      "# Title\n\nhello world",
    );
    expect(screen.getByRole("status")).toHaveAttribute(
      "title",
      expect.stringMatching(/^Saved at \d{2}:\d{2}:\d{2}$/),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVED_STICKY_MS + 10);
    });
    expect(screen.getByRole("status")).not.toHaveAttribute("title");
  });
});

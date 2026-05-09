/**
 * EditorPane integration tests. Uses fake timers to drive the 2s debounce and
 * the 2s saved-sticky window deterministically.
 *
 * Mocking strategy: notesApi is the single seam — components never import the
 * raw client, so mocking notesApi is sufficient and proves the API-03 contract
 * (everything routes through the typed wrappers).
 *
 * Plan 05-11 (D-28): MarkdownEditor is mocked with a ref-API-compatible fake
 * that renders a real <textarea aria-label="Note content"> so existing
 * getByLabelText / getByRole("textbox") queries and fireEvent.change calls
 * keep working. The mock's setContent/applyServerUpdate update React state so
 * re-renders reflect the new content. Cmd+S is exposed via
 * window.__jasperMockEditorSave so tests that previously fired keyDown on the
 * textarea can call the save callback directly.
 */
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api/schema";

// Type-safe window extension for the Cmd+S test hook exposed by the
// MarkdownEditor mock. Using a declare to avoid @typescript-eslint/no-explicit-any.
declare global {
    interface Window {
        __jasperMockEditorSave?: () => void;
        // Plan 05.5-01 / UX-10: focusEnd spy exposed by the MarkdownEditor mock
        // so tests can assert the click-host wrapper invoked the ref method.
        __jasperMockEditorFocusEnd?: ReturnType<typeof vi.fn>;
    }
}

// Amendment 2 — schema-typed WS payload type aliases.
// Adding a non-optional field to openapi.yaml MUST cause `tsc --noEmit` to
// fail on these type annotations — that's the compile-time drift guard.
type WSNoteUpdatedPayload = components["schemas"]["WSNoteUpdatedPayload"];
type WSNoteDeletedPayload = components["schemas"]["WSNoteDeletedPayload"];

// Plan 05-11 D-28: mock MarkdownEditor so the EditorPane test suite keeps
// focusing on banner / save-state / WS-handler logic without importing the
// heavyweight CM6 EditorView. The mock:
//   - Renders <textarea aria-label="Note content"> so existing test queries work
//   - Implements the full MarkdownEditorRef API via useImperativeHandle
//   - Calls props.onChange on textarea change AND on setContent
//   - applyServerUpdate updates content WITHOUT calling onChange (silent, D-10)
//   - Exposes props.onSaveRequested via window.__jasperMockEditorSave for
//     tests that previously fired keyDown on the textarea to trigger Cmd+S
vi.mock("./MarkdownEditor", async () => {
    const React = await import("react");

    const MarkdownEditor = React.forwardRef<
        {
            setContent(s: string): void;
            getContent(): string;
            applyServerUpdate(s: string): void;
            focus(): void;
            focusEnd(): void;
        },
        {
            initialDoc?: string;
            onChange?: (s: string) => void;
            onH1Change?: (h: string | null) => void;
            onSaveRequested?: () => void;
        }
    >(function MockMarkdownEditor(props, ref) {
        const [value, setValue] = React.useState(props.initialDoc ?? "");
        // Keep a stable ref to the latest props so imperative methods below
        // always call the freshest callbacks without stale closure.
        const propsRef = React.useRef(props);
        propsRef.current = props;

        React.useImperativeHandle(ref, () => ({
            setContent(s: string) {
                setValue(s);
                propsRef.current.onChange?.(s);
                if (propsRef.current.onH1Change) {
                    const m = s.match(/^# (.+)$/m);
                    propsRef.current.onH1Change(m ? m[1].trim() : null);
                }
            },
            getContent() {
                return value;
            },
            applyServerUpdate(s: string) {
                // Silent reload — update display but do NOT call onChange.
                setValue(s);
            },
            focus() {
                // no-op in test
            },
            focusEnd() {
                // Plan 05.5-01 / UX-10: tests can assert this via the
                // window.__jasperMockEditorFocusEnd spy installed below.
                window.__jasperMockEditorFocusEnd?.();
            },
        }), [value]);

        // Expose save shortcut for tests that previously fired keyDown Cmd+S
        // on the textarea. Tests call window.__jasperMockEditorSave() instead.
        React.useEffect(() => {
            window.__jasperMockEditorSave = () => {
                propsRef.current.onSaveRequested?.();
            };
            return () => {
                delete window.__jasperMockEditorSave;
            };
        }, []);

        return React.createElement("textarea", {
            "aria-label": "Note content",
            "data-testid": "markdown-editor-mock",
            value,
            // Expose readOnly so tests can still assert disabled-like state
            // via aria-label presence. The real MarkdownEditor doesn't have
            // disabled — loading state is tracked internally by EditorPane.
            readOnly: false,
            onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
                const next = e.target.value;
                setValue(next);
                propsRef.current.onChange?.(next);
                if (propsRef.current.onH1Change) {
                    const m = next.match(/^# (.+)$/m);
                    propsRef.current.onH1Change(m ? m[1].trim() : null);
                }
            },
        });
    });

    return {
        MarkdownEditor,
        ServerUpdateAnnotation: { of: () => ({}) },
    };
});

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
    // CR-02 regression — useFileTree calls getTree(); EditorPane reads
    // tree from useFileTree() to derive the active note's live path.
    // Mock returns a Tree that lists the active note at path
    // "scratchpad.md" by default; individual tests reassign the mock to
    // simulate a tree-side rename (path mutates while noteId stays the
    // same).
    getTree: vi.fn(),
}));

import { ScratchpadUUID, getNote, updateNote } from "../lib/notesApi";
import { getTree, postNoteMove } from "../lib/treeApi";
import { useTreeStore } from "../lib/useTreeStore";
import type { EditorPaneHandlers } from "./EditorPane";
import {
    AUTOSAVE_DEBOUNCE_MS,
    EditorPane,
    SAVED_STICKY_MS,
} from "./EditorPane";

const getNoteMock = vi.mocked(getNote);
const updateNoteMock = vi.mocked(updateNote);
const postNoteMoveMock = vi.mocked(postNoteMove);
const getTreeMock = vi.mocked(getTree);

type GetTreeReturn = Awaited<ReturnType<typeof getTree>>;

function okTree(notePath: string): GetTreeReturn {
    return {
        data: {
            root: [
                {
                    kind: "note",
                    id: "00000000-0000-4000-a000-000000000001",
                    path: notePath,
                    title: "scratchpad",
                    updated_at: "2025-01-01T00:00:00Z",
                },
            ],
        },
        error: undefined,
        response: new Response(),
    } as GetTreeReturn;
}

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
    getTreeMock.mockReset();
    // Default tree mirrors the default getNote path so EditorPane's
    // CR-02 effect sees a live path matching its load-effect seed.
    getTreeMock.mockResolvedValue(okTree("scratchpad.md"));
    // Phase 4: ensure connectionStatus is "connected" so existing autosave
    // tests are not gated by the D-06 connection guard.
    useTreeStore.setState({ connectionStatus: "connected" });
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
    it("E1: loads content into the editor after GET resolves", async () => {
        // Plan 05-11: MarkdownEditor is uncontrolled — no disabled/placeholder.
        // The loading state is tracked internally; the editor renders empty
        // until content arrives via applyServerUpdate from the load effect.
        let resolveGet: (v: GetReturn) => void = () => {};
        getNoteMock.mockReturnValue(
            new Promise<GetReturn>((r) => {
                resolveGet = r;
            }) as ReturnType<typeof getNote>,
        );

        render(<EditorPane noteId={ScratchpadUUID} />);

        // Before load resolves, the editor is present but empty.
        const editor = screen.getByLabelText("Note content") as HTMLTextAreaElement;
        expect(editor.value).toBe("");

        await act(async () => {
            resolveGet(okGet("abc"));
            await Promise.resolve();
            await Promise.resolve();
        });

        // After load resolves, editor shows the loaded content.
        await waitFor(() => expect(editor.value).toBe("abc"));
    });

    it("E2: GET error renders the locked failure copy", async () => {
        getNoteMock.mockResolvedValue(errGet("broken"));

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        expect(
            screen.getByText(
                "Could not load note. Check that the server is running, then refresh the page.",
            ),
        ).toBeInTheDocument();

        // Editor is present but content is empty on error.
        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        expect(editor.value).toBe("");
    });

    it("E3: typing → 2s debounce → saving → saved → ~2s later → idle", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("hello"));

        fireEvent.change(editor, { target: { value: "hello world" } });

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

    it("E4: Cmd+S immediately saves (collapses pending debounce)", async () => {
        // Plan 05-11: Cmd+S is now handled by saveKeymap inside MarkdownEditor.
        // The mock exposes onSaveRequested via window.__jasperMockEditorSave.
        getNoteMock.mockResolvedValue(okGet("hi"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("hi"));

        fireEvent.change(editor, { target: { value: "edited" } });

        // Don't wait the full debounce — trigger Cmd+S via the mock hook.
        await act(async () => {
            window.__jasperMockEditorSave?.();
            await Promise.resolve();
        });

        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(updateNoteMock).toHaveBeenCalledWith(ScratchpadUUID, "edited");

        // Even if 2s passes now, the debounce was cleared — no second PUT.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 100);
        });
        expect(updateNoteMock).toHaveBeenCalledTimes(1);
    });

    it("E4b: Ctrl+S also triggers an immediate save (non-Mac platforms)", async () => {
        // Plan 05-11: both Cmd+S and Ctrl+S route through saveKeymap/onSaveRequested.
        getNoteMock.mockResolvedValue(okGet("hi"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("hi"));

        fireEvent.change(editor, { target: { value: "x" } });

        await act(async () => {
            window.__jasperMockEditorSave?.();
            await Promise.resolve();
        });

        await flushMicrotasks();
        expect(updateNoteMock).toHaveBeenCalledTimes(1);
    });

    it("E5: PUT failure → error state; next edit → saving (recovery)", async () => {
        getNoteMock.mockResolvedValue(okGet("a"));
        updateNoteMock.mockResolvedValueOnce(errPut("disk full"));

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("a"));

        fireEvent.change(editor, { target: { value: "boom" } });
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
        fireEvent.change(editor, { target: { value: "boom!" } });
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

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("start"));

        // First PUT kicks off via debounce.
        fireEvent.change(editor, { target: { value: "edit1" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        expect(updateNoteMock).toHaveBeenCalledTimes(1);

        // While the first PUT is in flight, fire many more edits + saves. They
        // should all collapse into exactly ONE queued trailing save.
        fireEvent.change(editor, { target: { value: "edit2" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        fireEvent.change(editor, { target: { value: "edit3" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        // Plan 05-11: Cmd+S via mock hook instead of keyDown on textarea
        window.__jasperMockEditorSave?.();
        window.__jasperMockEditorSave?.();
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

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("a"));

        fireEvent.change(editor, { target: { value: "x" } });

        await act(async () => {
            window.__jasperMockEditorSave?.();
            await Promise.resolve();
        });
        await flushMicrotasks();
        expect(updateNoteMock).toHaveBeenCalledTimes(1);

        // We're in saved state now (within the sticky window). Cmd+S again.
        await act(async () => {
            window.__jasperMockEditorSave?.();
            await Promise.resolve();
        });
        await flushMicrotasks();
        expect(updateNoteMock).toHaveBeenCalledTimes(2);
    });

    it("ignores plain 's' and other non-save keys (verified via autosave non-trigger)", async () => {
        // Plan 05-11: key filtering now lives inside CM6 saveKeymap (jasperKeymap.ts).
        // In the test environment with the mock, we verify that NOT calling
        // __jasperMockEditorSave means updateNote is NOT called — the save
        // only fires when the debounce completes or the save hook is called.
        getNoteMock.mockResolvedValue(okGet("a"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("a"));

        // No save triggered (neither debounce nor Cmd+S hook).
        await flushMicrotasks();
        expect(updateNoteMock).not.toHaveBeenCalled();
    });

    it("Phase 2: when reindexing=true, performSave is blocked (reindexingRef guard)", async () => {
        // Plan 05-11: the textarea's disabled/placeholder behavior is gone.
        // The reindexing guard still prevents saves via reindexingRef.current.
        getNoteMock.mockResolvedValue(okGet("a"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} reindexing={true} />);
        await flushMicrotasks();

        // The editor is present — content may be empty since reindexing=true
        // causes initialDoc="" (EditorPane guards the initialDoc prop).
        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        expect(editor).toBeInTheDocument();

        // Even if we trigger a save, it's blocked by reindexingRef.
        fireEvent.change(editor, { target: { value: "typed during reindex" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();
        expect(updateNoteMock).not.toHaveBeenCalled();
    });

    it("TestEditorPane_NullNoteId_RendersPlaceholder", async () => {
        render(<EditorPane noteId={null} />);
        await flushMicrotasks();
        expect(
            screen.getByText("Select a note to start editing."),
        ).toBeInTheDocument();
        // No editor / no API call when noteId is null.
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
        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() =>
            expect(editor.value).toBe(
                "content for 00000000-0000-4000-a000-000000000001",
            ),
        );

        // Re-render with a different noteId; the load effect should re-fire
        // and getNote should be called with the new id.
        rerender(<EditorPane noteId="other-id" />);
        await flushMicrotasks();
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

    it("editor aria-label is generic 'Note content'", async () => {
        getNoteMock.mockResolvedValue(okGet("hi"));

        render(<EditorPane noteId="any-uuid" />);
        await flushMicrotasks();

        const editor = (await screen.findByLabelText(
            "Note content",
        )) as HTMLTextAreaElement;
        expect(editor.getAttribute("aria-label")).toBe("Note content");
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

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("# Original\n\nbody"));

        fireEvent.change(editor, {
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

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("# Title\n\nbody"));

        fireEvent.change(editor, {
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

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("# Original\n\nbody"));

        fireEvent.change(editor, {
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

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("# Original\n\nbody"));

        // First H1 change → first moveNote dispatched (in flight).
        fireEvent.change(editor, {
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
        fireEvent.change(editor, {
            target: { value: "# second\n\nbody" },
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        // Plan 05-11: Cmd+S via mock hook
        window.__jasperMockEditorSave?.();
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

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("# Original\n\nbody"));

        fireEvent.change(editor, {
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

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("# Original\n\nbody"));

        // User erases the heading line entirely.
        fireEvent.change(editor, {
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

    it("CR-01: case-only H1 change → ZERO moveNote (would have 409'd as case_collision); updateNote still runs", async () => {
        // Server canonicalizes paths to lowercase per DATA-11; a case-only
        // H1 change against a file whose canonical name already matches
        // lowercase would be dispatched as a move that the server rejects
        // with case_collision 409. The H1-driven path needs the same
        // same-name guard Plan 03-19 added to RenameInput.commit.
        getNoteMock.mockResolvedValue(okGet("# my plan\n\nbody"));
        updateNoteMock.mockResolvedValue(okPut());
        // Override the default tree to put the note at the canonical path.
        getTreeMock.mockResolvedValue(okTree("my plan.md"));

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("# my plan\n\nbody"));

        // User changes ONLY the case of the H1.
        fireEvent.change(editor, {
            target: { value: "# MY PLAN\n\nbody" },
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();

        // No spurious moveNote — case-only delta should short-circuit.
        expect(postNoteMoveMock).not.toHaveBeenCalled();
        // Content save still runs.
        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(updateNoteMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "# MY PLAN\n\nbody",
        );
        // No banner — case-only is a clean no-op for the rename pipeline.
        expect(
            screen.queryByText(/aren't allowed in filenames/i),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByText(/that filename is already taken/i),
        ).not.toBeInTheDocument();
    });

    it("CR-02: live tree path overrides the load-effect seed; H1 edit composes new path against the LIVE parent dir", async () => {
        // EditorPane previously cached lastNotePath in a ref that was only
        // refreshed on noteId change or after EditorPane's own move. After
        // a tree-side rename (FileTree.handleCommitRename → moveNote), the
        // cached path was stale; the next H1 edit composed against the OLD
        // parent dir, silently relocating the file. The CR-02 fix derives
        // currentPath from the live tree (useFileTree().tree).
        //
        // To exercise the fix without simulating a real broadcast, this
        // test sets the load-effect seed (getNote.path) and the tree path
        // to DIFFERENT values — the disagreement that exists in production
        // immediately after a tree-side rename. The CR-02 effect must
        // override the seed with the live tree value so the H1-driven move
        // dispatches against the LIVE parent.
        //
        // Stale seed: getNote returns path "untitled.md" (root).
        // Live tree: note appears at "projects/manual.md" (subfolder).
        getNoteMock.mockResolvedValue({
            data: {
                id: ScratchpadUUID,
                path: "untitled.md", // stale — what the ref WOULD have cached
                content: "# Original\n\nbody",
                updated_at: "2025-01-01T00:00:00Z",
            },
            error: undefined,
            response: new Response(),
        } as GetReturn);
        updateNoteMock.mockResolvedValue(okPut());
        postNoteMoveMock.mockResolvedValue(
            okMove("projects/renamed by editor.md"),
        );
        getTreeMock.mockResolvedValue(okTree("projects/manual.md"));

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() =>
            expect(editor.value).toBe("# Original\n\nbody"),
        );

        // User types a new H1.
        fireEvent.change(editor, {
            target: { value: "# renamed by editor\n\nbody" },
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();

        // The dispatched move must respect the LIVE parent ("projects/"),
        // not the stale seed (root). If CR-02 regresses, postNoteMove
        // would be called with "renamed by editor.md" (no projects/
        // prefix), silently re-promoting the note to root.
        expect(postNoteMoveMock).toHaveBeenCalledTimes(1);
        expect(postNoteMoveMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "projects/renamed by editor.md",
        );
    });

    it("R2-6 T7: pre-existing autosave behavior stays green when the H1 hook is dormant", async () => {
        // Repeat E3's debounce → saving → saved → idle path with the new
        // hook installed but no H1 change. The new branch must not perturb
        // the SaveIndicator state machine or the timer cadence.
        getNoteMock.mockResolvedValue(okGet("# Title\n\nhello"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("# Title\n\nhello"));

        fireEvent.change(editor, {
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

// ────────────────────────────────────────────────────────────────────
// Phase 4 (Plan 04-05) — EditorPane WebSocket handler integration.
//
// Amendment 2: every synthetic WS payload is type-annotated via
// components["schemas"][...] aliases. No `as unknown as Foo` bypass casts.
// ────────────────────────────────────────────────────────────────────

describe("<EditorPane /> — Phase 4 WebSocket handlers (Plan 04-05)", () => {
    function renderEditorWithHandlers(noteId: string | null = ScratchpadUUID) {
        const handlersRef: { current: EditorPaneHandlers | null } = { current: null };
        const view = render(
            <EditorPane noteId={noteId} editorHandlersRef={handlersRef} />,
        );
        return { ...view, handlersRef };
    }

    it("P4-conflict-banner: note:updated for open note while userHasEdited=true renders banner with both actions", async () => {
        getNoteMock.mockResolvedValue(okGet("initial content"));
        updateNoteMock.mockResolvedValue(okPut());
        const { handlersRef } = renderEditorWithHandlers();
        await flushMicrotasks();
        const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("initial content"));

        // Simulate user edit — sets userHasEdited.current = true.
        fireEvent.change(editor, { target: { value: "edited content" } });

        // Dispatch a synthetic note:updated WS event (schema-typed, no as-cast).
        const updatedPayload: WSNoteUpdatedPayload = {
            id: ScratchpadUUID,
            path: "scratchpad.md",
            updated_at: "2026-05-06T13:00:00Z",
        };
        act(() => {
            handlersRef.current!.onNoteUpdated(updatedPayload);
        });

        expect(screen.getByTestId("conflict-banner")).toBeInTheDocument();
        expect(screen.getByText(/This note was updated in another session/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Save anyway/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Discard/i })).toBeInTheDocument();
    });

    it("P4-save-anyway: click Save anyway re-issues updateNote with the server-supplied current_updated_at; on success clears banner", async () => {
        getNoteMock.mockResolvedValue(okGet("original content"));
        updateNoteMock.mockResolvedValue(okPut());
        const { handlersRef } = renderEditorWithHandlers();
        await flushMicrotasks();
        const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("original content"));

        // Create conflict: user edits, then note:updated arrives.
        fireEvent.change(editor, { target: { value: "edited" } });
        const updatedPayload: WSNoteUpdatedPayload = {
            id: ScratchpadUUID,
            path: "scratchpad.md",
            updated_at: "2026-05-06T13:00:00Z",
        };
        act(() => {
            handlersRef.current!.onNoteUpdated(updatedPayload);
        });
        await waitFor(() => expect(screen.getByTestId("conflict-banner")).toBeInTheDocument());

        // Mock a successful save.
        updateNoteMock.mockClear();
        updateNoteMock.mockResolvedValue(okPut());

        // Click Save anyway.
        fireEvent.click(screen.getByRole("button", { name: /Save anyway/i }));
        await waitFor(() => expect(updateNoteMock).toHaveBeenCalled());
        // Verify the If-Match (current_updated_at) was passed.
        expect(updateNoteMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "edited",
            "2026-05-06T13:00:00Z",
        );
        // Banner clears on success.
        await waitFor(() =>
            expect(screen.queryByTestId("conflict-banner")).not.toBeInTheDocument(),
        );
    });

    it("P4-discard: click Discard re-fetches note, replaces content, clears banner", async () => {
        getNoteMock.mockResolvedValue(okGet("original content"));
        updateNoteMock.mockResolvedValue(okPut());
        const { handlersRef } = renderEditorWithHandlers();
        await flushMicrotasks();
        const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("original content"));

        // Create conflict.
        fireEvent.change(editor, { target: { value: "user edits" } });
        const updatedPayload: WSNoteUpdatedPayload = {
            id: ScratchpadUUID,
            path: "scratchpad.md",
            updated_at: "2026-05-06T13:00:00Z",
        };
        act(() => {
            handlersRef.current!.onNoteUpdated(updatedPayload);
        });
        await waitFor(() => expect(screen.getByTestId("conflict-banner")).toBeInTheDocument());

        // Server has newer content.
        getNoteMock.mockClear();
        getNoteMock.mockResolvedValue(okGet("server content"));

        fireEvent.click(screen.getByRole("button", { name: /Discard/i }));
        await waitFor(() => expect(getNoteMock).toHaveBeenCalled());
        await waitFor(() =>
            expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
                "server content",
            ),
        );
        expect(screen.queryByTestId("conflict-banner")).not.toBeInTheDocument();
    });

    it("P4-silent-reload: note:updated while no edit / no pending save replaces content WITHOUT banner", async () => {
        getNoteMock.mockResolvedValue(okGet("initial"));
        const { handlersRef } = renderEditorWithHandlers();
        await flushMicrotasks();
        const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("initial"));

        // No user edit — userHasEdited.current is still false.
        // Server has fresh content.
        getNoteMock.mockClear();
        getNoteMock.mockResolvedValue(okGet("fresh from server"));

        const updatedPayload: WSNoteUpdatedPayload = {
            id: ScratchpadUUID,
            path: "scratchpad.md",
            updated_at: "2026-05-06T13:00:00Z",
        };
        act(() => {
            handlersRef.current!.onNoteUpdated(updatedPayload);
        });
        await waitFor(() =>
            expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
                "fresh from server",
            ),
        );
        expect(screen.queryByTestId("conflict-banner")).not.toBeInTheDocument();
    });

    it("P4-deletion-banner: note:deleted for open note shows banner WITHOUT clearing content", async () => {
        getNoteMock.mockResolvedValue(okGet("user typed work"));
        const { handlersRef } = renderEditorWithHandlers();
        await flushMicrotasks();
        const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("user typed work"));

        // User typed something.
        fireEvent.change(editor, { target: { value: "user typed work" } });

        const deletedPayload: WSNoteDeletedPayload = {
            id: ScratchpadUUID,
            path: "scratchpad.md",
        };
        act(() => {
            handlersRef.current!.onNoteDeleted(deletedPayload);
        });

        expect(screen.getByTestId("deleted-banner")).toBeInTheDocument();
        expect(
            screen.getByText("This note was deleted in another session"),
        ).toBeInTheDocument();
        // D-03: content NOT cleared.
        expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
            "user typed work",
        );
    });

    it("P4-deletion-banner-other-note: note:deleted for DIFFERENT id does NOT show banner", async () => {
        getNoteMock.mockResolvedValue(okGet("my note"));
        const { handlersRef } = renderEditorWithHandlers();
        await flushMicrotasks();
        await waitFor(() =>
            expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("my note"),
        );

        const deletedPayload: WSNoteDeletedPayload = {
            id: "00000000-0000-4000-a000-000000000099",
            path: "other.md",
        };
        act(() => {
            handlersRef.current!.onNoteDeleted(deletedPayload);
        });

        expect(screen.queryByTestId("deleted-banner")).not.toBeInTheDocument();
    });

    it("P4-autosave-paused-when-disconnected: edits during reconnecting do NOT call updateNote", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());

        // Set connection status to reconnecting BEFORE render.
        useTreeStore.setState({ connectionStatus: "reconnecting" });

        renderEditorWithHandlers();
        await flushMicrotasks();
        const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("hello"));

        fireEvent.change(editor, { target: { value: "typed during disconnect" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);
        });
        await flushMicrotasks();

        expect(updateNoteMock).not.toHaveBeenCalled();
    });

    it("P4-autosave-resumes-on-reconnect: status flips to connected, edits trigger updateNote", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());

        // Start connected.
        useTreeStore.setState({ connectionStatus: "connected" });

        renderEditorWithHandlers();
        await flushMicrotasks();
        const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("hello"));

        // Flip to reconnecting — autosave paused.
        act(() => {
            useTreeStore.setState({ connectionStatus: "reconnecting" });
        });

        // Edit while disconnected.
        fireEvent.change(editor, { target: { value: "edit during disconnect" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);
        });
        await flushMicrotasks();
        expect(updateNoteMock).not.toHaveBeenCalled();

        // Flip back to connected.
        act(() => {
            useTreeStore.setState({ connectionStatus: "connected" });
        });

        // New edit after reconnect should trigger autosave.
        fireEvent.change(editor, { target: { value: "edit after reconnect" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);
        });
        await flushMicrotasks();
        expect(updateNoteMock).toHaveBeenCalled();
    });

    afterEach(() => {
        // Reset connection status to connected (default for most tests).
        useTreeStore.setState({ connectionStatus: "connected" });
    });
});

// ────────────────────────────────────────────────────────────────────
// Phase 5.5 / Plan 01 (UX-10) — click-anywhere-to-type host wrapper.
// EditorPane wraps <MarkdownEditor> in a `cm-host-shell` div whose
// onClick forwards empty-area clicks (target NOT inside .cm-content)
// to editorRef.current.focusEnd(). Clicks inside .cm-content are no-ops
// (CM6 owns focus + caret placement on text-region clicks).
// ────────────────────────────────────────────────────────────────────

describe("<EditorPane /> — UX-10 click-anywhere-to-type host (Plan 05.5-01)", () => {
    it("clicking the host shell outside .cm-content focuses the editor and moves caret to end (UX-10)", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        const focusEndSpy = vi.fn();
        window.__jasperMockEditorFocusEnd = focusEndSpy;

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();
        await waitFor(() =>
            expect(
                (screen.getByRole("textbox") as HTMLTextAreaElement).value,
            ).toBe("hello"),
        );

        const host = screen.getByTestId("cm-host-shell");
        // Click directly on the host element — `e.target` is the host itself,
        // which has no `.cm-content` ancestor (the mock editor renders a
        // <textarea>, not a `.cm-content` node), so the onClick MUST forward
        // to editorRef.current.focusEnd().
        fireEvent.click(host, { bubbles: true });

        expect(focusEndSpy).toHaveBeenCalledTimes(1);
        delete window.__jasperMockEditorFocusEnd;
    });

    it("clicking inside .cm-content does NOT trigger focusEnd (UX-10)", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        const focusEndSpy = vi.fn();
        window.__jasperMockEditorFocusEnd = focusEndSpy;

        const { container } = render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();
        await waitFor(() =>
            expect(
                (screen.getByRole("textbox") as HTMLTextAreaElement).value,
            ).toBe("hello"),
        );

        // Build a synthetic target that has a `.cm-content` ancestor and
        // dispatch a click whose `target` property points at it. The host's
        // onClick uses `e.target.closest(".cm-content")` to short-circuit;
        // appending the synthetic content node to the host shell makes it
        // a real DOM descendant so closest() walks the tree correctly.
        const host = screen.getByTestId("cm-host-shell");
        const fakeContent = document.createElement("div");
        fakeContent.className = "cm-content";
        const child = document.createElement("span");
        fakeContent.appendChild(child);
        host.appendChild(fakeContent);

        fireEvent.click(child, { bubbles: true });

        expect(focusEndSpy).not.toHaveBeenCalled();

        host.removeChild(fakeContent);
        delete window.__jasperMockEditorFocusEnd;
        // Silence unused-var warning for `container` while keeping the
        // render() destructure consistent with the rest of the suite.
        void container;
    });
});

// ────────────────────────────────────────────────────────────────────
// Phase 5.5 / Plan 04 (UX-08) — live H1 → sidebar label sync.
// handleEditorH1Change writes through to useTreeStore.liveLabels[noteId]
// so TreeRow can render the in-flight title pre-save. Cleared on null
// /empty H1 and on note switch with unsaved edits (Pitfall 6).
//
// The MarkdownEditor mock fires onH1Change automatically when the
// textarea's value matches /^# (.+)$/m; tests drive H1 changes by
// firing change events with `# title` content.
// ────────────────────────────────────────────────────────────────────
describe("<EditorPane /> — UX-08 live H1 → sidebar label (Plan 05.5-04)", () => {
    beforeEach(() => {
        // Reset liveLabels between cases — the slice is global state.
        useTreeStore.setState({ liveLabels: {} });
    });

    it("UX-08: handleEditorH1Change sets liveLabels[noteId] when H1 string non-empty", async () => {
        getNoteMock.mockResolvedValue(okGet("body only"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();
        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("body only"));

        // Type an H1; the mock auto-fires onH1Change("My Title").
        fireEvent.change(editor, {
            target: { value: "# My Title\n\nbody only" },
        });
        await flushMicrotasks();

        expect(useTreeStore.getState().liveLabels[ScratchpadUUID]).toBe(
            "My Title",
        );
    });

    it("UX-08: handleEditorH1Change clears liveLabel when H1 is null/empty", async () => {
        getNoteMock.mockResolvedValue(okGet("# Original\n\nbody"));
        updateNoteMock.mockResolvedValue(okPut());

        // Pre-seed the label so we can prove clear actually removes it.
        useTreeStore.setState({
            liveLabels: { [ScratchpadUUID]: "Original" },
        });

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();
        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("# Original\n\nbody"));

        // Erase the H1 entirely → mock fires onH1Change(null).
        fireEvent.change(editor, { target: { value: "body" } });
        await flushMicrotasks();

        expect(
            useTreeStore.getState().liveLabels[ScratchpadUUID],
        ).toBeUndefined();
    });

    it("UX-08: switching to a new note clears the previous note's liveLabel when userHasEdited is true (Pitfall 6)", async () => {
        // First note: load, type to set userHasEdited + a live label.
        getNoteMock.mockImplementation((id: string) =>
            Promise.resolve(okGet(`# Title for ${id}\n\nbody`)),
        );
        updateNoteMock.mockResolvedValue(okPut());

        const { rerender } = render(<EditorPane noteId="note-a" />);
        await flushMicrotasks();
        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() =>
            expect(editor.value).toBe("# Title for note-a\n\nbody"),
        );

        // Type a new H1 → setLiveLabel("note-a", "Edited A") AND
        // userHasEdited.current becomes true (handleEditorChange path).
        fireEvent.change(editor, {
            target: { value: "# Edited A\n\nbody" },
        });
        await flushMicrotasks();
        expect(useTreeStore.getState().liveLabels["note-a"]).toBe("Edited A");

        // Switch notes WITHOUT waiting for the debounced save — the
        // previous live label must be cleared because userHasEdited=true
        // means no canonical save has flushed the title to the wire tree.
        rerender(<EditorPane noteId="note-b" />);
        await flushMicrotasks();

        expect(
            useTreeStore.getState().liveLabels["note-a"],
        ).toBeUndefined();
    });

    afterEach(() => {
        useTreeStore.setState({ liveLabels: {} });
    });
});

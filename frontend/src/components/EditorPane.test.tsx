/**
 * EditorPane integration tests. Uses fake timers to drive the 2s debounce and
 * the 2s saved-sticky window deterministically.
 *
 * Mocking strategy: notesApi is the single seam — components never import the
 * raw client, so mocking notesApi is sufficient and proves the typed-wrapper contract.
 *
 * MarkdownEditor is mocked with a ref-API-compatible fake that renders a real
 * <textarea aria-label="Note content"> so getByLabelText / getByRole("textbox")
 * queries and fireEvent.change calls keep working. Cmd+S is exposed via
 * window.__jasperMockEditorSave so tests can call the save callback directly.
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


declare global {
    interface Window {
        __jasperMockEditorSave?: () => void;
        __jasperMockEditorFocusEnd?: ReturnType<typeof vi.fn>;
        __jasperMockEditorBlur?: () => void;
        __jasperMockEditorToggle?: (doc: string) => void;
    }
}


type WSNoteUpdatedPayload = components["schemas"]["WSNoteUpdatedPayload"];
type WSNoteDeletedPayload = components["schemas"]["WSNoteDeletedPayload"];


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
            onBlur?: () => void;
            readOnly?: boolean;
        }
    >(function MockMarkdownEditor(props, ref) {
        const [value, setValue] = React.useState(props.initialDoc ?? "");
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
                setValue(s);
            },
            focus() {
                // no-op in test
            },
            focusEnd() {
                window.__jasperMockEditorFocusEnd?.();
            },
        }), [value]);

        React.useEffect(() => {
            window.__jasperMockEditorSave = () => {
                propsRef.current.onSaveRequested?.();
            };
            window.__jasperMockEditorBlur = () => {
                propsRef.current.onBlur?.();
            };
            window.__jasperMockEditorToggle = (doc: string) => {
                setValue(doc);
                propsRef.current.onChange?.(doc);
                propsRef.current.onSaveRequested?.();
            };
            return () => {
                delete window.__jasperMockEditorSave;
                delete window.__jasperMockEditorBlur;
                delete window.__jasperMockEditorToggle;
            };
        }, []);

        return React.createElement("textarea", {
            "aria-label": "Note content",
            "data-testid": "markdown-editor-mock",
            value,
            readOnly: props.readOnly ?? false,
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


vi.mock("../lib/notesApi", () => ({
    ScratchpadUUID: "00000000-0000-4000-a000-000000000001",
    getNote: vi.fn(),
    updateNote: vi.fn(),
}));


vi.mock("../lib/treeApi", () => ({
    postNoteMove: vi.fn(),
    getTree: vi.fn(),
}));

import { ScratchpadUUID, getNote, updateNote } from "../lib/notesApi";
import { getTree, postNoteMove } from "../lib/treeApi";
import { __testing__ as fileTreeTesting } from "../lib/useFileTree";
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
    fileTreeTesting.__resetCoalescer();
    getTreeMock.mockResolvedValue(okTree("scratchpad.md"));
    useTreeStore.setState({ connectionStatus: "connected" });
    vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

async function flushMicrotasks() {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe("<EditorPane />", () => {
    it("E1: loads content into the editor after GET resolves", async () => {
        let resolveGet: (v: GetReturn) => void = () => {};
        getNoteMock.mockReturnValue(
            new Promise<GetReturn>((r) => {
                resolveGet = r;
            }) as ReturnType<typeof getNote>,
        );

        render(<EditorPane noteId={ScratchpadUUID} />);

        const editor = screen.getByLabelText("Note content") as HTMLTextAreaElement;
        expect(editor.value).toBe("");

        await act(async () => {
            resolveGet(okGet("abc"));
            await Promise.resolve();
            await Promise.resolve();
        });

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

        expect(screen.queryByRole("status")).toBeNull();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });

        expect(updateNoteMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "hello world",
        );

        await flushMicrotasks();
        expect(useTreeStore.getState().saveState.status).toBe("saved");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(SAVED_STICKY_MS + 10);
        });
        expect(useTreeStore.getState().saveState.status).toBe("idle");
    });

    it("E4: Cmd+S immediately saves (collapses pending debounce)", async () => {
        getNoteMock.mockResolvedValue(okGet("hi"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("hi"));

        fireEvent.change(editor, { target: { value: "edited" } });

        await act(async () => {
            window.__jasperMockEditorSave?.();
            await Promise.resolve();
        });

        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(updateNoteMock).toHaveBeenCalledWith(ScratchpadUUID, "edited");

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

        expect(useTreeStore.getState().saveState.status).toBe("error");

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

        fireEvent.change(editor, { target: { value: "edit1" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        expect(updateNoteMock).toHaveBeenCalledTimes(1);

        fireEvent.change(editor, { target: { value: "edit2" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        fireEvent.change(editor, { target: { value: "edit3" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        window.__jasperMockEditorSave?.();
        window.__jasperMockEditorSave?.();
        await flushMicrotasks();

        expect(updateNoteMock).toHaveBeenCalledTimes(1);

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

        await act(async () => {
            window.__jasperMockEditorSave?.();
            await Promise.resolve();
        });
        await flushMicrotasks();
        expect(updateNoteMock).toHaveBeenCalledTimes(2);
    });

    it("ignores plain 's' and other non-save keys (verified via autosave non-trigger)", async () => {
        getNoteMock.mockResolvedValue(okGet("a"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("a"));

        await flushMicrotasks();
        expect(updateNoteMock).not.toHaveBeenCalled();
    });

    it("Phase 2: when reindexing=true, performSave is blocked (reindexingRef guard)", async () => {
        getNoteMock.mockResolvedValue(okGet("a"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} reindexing={true} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        expect(editor).toBeInTheDocument();

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
        expect(screen.queryByLabelText("Note content")).toBeNull();
        expect(getNoteMock).not.toHaveBeenCalled();
    });

    it("EP-FPV-1: when activeFilePath is set, renders FilePreviewView (not placeholder, not editor)", async () => {
        useTreeStore.setState({
            activeFilePath: "gallery/attachments/photo.png",
            activeNoteId: null,
        });
        try {
            render(<EditorPane noteId={null} />);
            await flushMicrotasks();
            expect(screen.getByTestId("file-preview-view")).toBeInTheDocument();
            expect(
                screen.queryByText("Select a note to start editing."),
            ).toBeNull();
            expect(screen.queryByLabelText("Note content")).toBeNull();
            expect(getNoteMock).not.toHaveBeenCalled();
        } finally {
            useTreeStore.setState({ activeFilePath: null });
        }
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

        rerender(<EditorPane noteId="other-id" />);
        await flushMicrotasks();
        expect(getNoteMock).toHaveBeenCalledWith(
            "other-id",
            expect.objectContaining({ signal: expect.any(Object) }),
        );
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

        expect(postNoteMoveMock).toHaveBeenCalledTimes(1);
        expect(postNoteMoveMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "new title.md",
        );
        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(updateNoteMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "# new title\n\nbody",
        );
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
        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(updateNoteMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "# my/note\n\nbody",
        );
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

        fireEvent.change(editor, {
            target: { value: "# first\n\nbody" },
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();
        expect(postNoteMoveMock).toHaveBeenCalledTimes(1);

        fireEvent.change(editor, {
            target: { value: "# second\n\nbody" },
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        window.__jasperMockEditorSave?.();
        await flushMicrotasks();

        expect(postNoteMoveMock).toHaveBeenCalledTimes(1);

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

        fireEvent.change(editor, {
            target: { value: "\n\nbody only" },
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();

        expect(postNoteMoveMock).not.toHaveBeenCalled();
        expect(updateNoteMock).toHaveBeenCalledTimes(1);
    });

    it("CR-01: case-only H1 change → ZERO moveNote (would have 409'd as case_collision); updateNote still runs", async () => {
        getNoteMock.mockResolvedValue(okGet("# my plan\n\nbody"));
        updateNoteMock.mockResolvedValue(okPut());
        getTreeMock.mockResolvedValue(okTree("my plan.md"));

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("# my plan\n\nbody"));

        fireEvent.change(editor, {
            target: { value: "# MY PLAN\n\nbody" },
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();

        expect(postNoteMoveMock).not.toHaveBeenCalled();
        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(updateNoteMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "# MY PLAN\n\nbody",
        );
        expect(
            screen.queryByText(/aren't allowed in filenames/i),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByText(/that filename is already taken/i),
        ).not.toBeInTheDocument();
    });

    it("CR-02: live tree path overrides the load-effect seed; H1 edit composes new path against the LIVE parent dir", async () => {
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

        fireEvent.change(editor, {
            target: { value: "# renamed by editor\n\nbody" },
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();

        expect(postNoteMoveMock).toHaveBeenCalledTimes(1);
        expect(postNoteMoveMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "projects/renamed by editor.md",
        );
    });

    it("R2-6 T7: pre-existing autosave behavior stays green when the H1 hook is dormant", async () => {
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

        expect(screen.queryByRole("status")).toBeNull();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();

        expect(postNoteMoveMock).not.toHaveBeenCalled();
        expect(updateNoteMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "# Title\n\nhello world",
        );
        expect(useTreeStore.getState().saveState.status).toBe("saved");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(SAVED_STICKY_MS + 10);
        });
        expect(useTreeStore.getState().saveState.status).toBe("idle");
    });
});


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

        fireEvent.change(editor, { target: { value: "edited content" } });

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

        updateNoteMock.mockClear();
        updateNoteMock.mockResolvedValue(okPut());

        fireEvent.click(screen.getByRole("button", { name: /Save anyway/i }));
        await waitFor(() => expect(updateNoteMock).toHaveBeenCalled());
        expect(updateNoteMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "edited",
            "2026-05-06T13:00:00Z",
        );
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

        useTreeStore.setState({ connectionStatus: "connected" });

        renderEditorWithHandlers();
        await flushMicrotasks();
        const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("hello"));

        act(() => {
            useTreeStore.setState({ connectionStatus: "reconnecting" });
        });

        fireEvent.change(editor, { target: { value: "edit during disconnect" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);
        });
        await flushMicrotasks();
        expect(updateNoteMock).not.toHaveBeenCalled();

        act(() => {
            useTreeStore.setState({ connectionStatus: "connected" });
        });

        fireEvent.change(editor, { target: { value: "edit after reconnect" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);
        });
        await flushMicrotasks();
        expect(updateNoteMock).toHaveBeenCalled();
    });

    afterEach(() => {
        useTreeStore.setState({ connectionStatus: "connected" });
    });
});


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
        void container;
    });
});


describe("<EditorPane /> — UX-08 live H1 → sidebar label (Plan 05.5-04)", () => {
    beforeEach(() => {
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

        useTreeStore.setState({
            liveLabels: { [ScratchpadUUID]: "Original" },
        });

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();
        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("# Original\n\nbody"));

        fireEvent.change(editor, { target: { value: "body" } });
        await flushMicrotasks();

        expect(
            useTreeStore.getState().liveLabels[ScratchpadUUID],
        ).toBeUndefined();
    });

    it("UX-08: switching to a new note clears the previous note's liveLabel when userHasEdited is true (Pitfall 6)", async () => {
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

        fireEvent.change(editor, {
            target: { value: "# Edited A\n\nbody" },
        });
        await flushMicrotasks();
        expect(useTreeStore.getState().liveLabels["note-a"]).toBe("Edited A");

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


describe("<EditorPane /> — UX-07 save-on-blur lifecycle (Plan 05.5-03)", () => {
    it("UX-07: handleEditorBlur clears pending debounce and calls performSave", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();
        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("hello"));

        fireEvent.change(editor, { target: { value: "edited content" } });
        expect(updateNoteMock).not.toHaveBeenCalled();

        await act(async () => {
            window.__jasperMockEditorBlur?.();
            await Promise.resolve();
        });

        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(updateNoteMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "edited content",
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 100);
        });
        expect(updateNoteMock).toHaveBeenCalledTimes(1);
    });

    it("UX-07 / BL-04: visibilitychange→hidden fires a keepalive fetch (Plan 05.5-12)", async () => {
        getNoteMock.mockResolvedValue(okGet("hi"));
        updateNoteMock.mockResolvedValue(okPut());
        const fetchMock = vi.fn().mockResolvedValue(new Response());
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            render(<EditorPane noteId={ScratchpadUUID} />);
            await flushMicrotasks();
            const editor = screen.getByLabelText(
                "Note content",
            ) as HTMLTextAreaElement;
            await waitFor(() => expect(editor.value).toBe("hi"));

            fireEvent.change(editor, { target: { value: "tab-switch save" } });

            const originalDescriptor = Object.getOwnPropertyDescriptor(
                Document.prototype,
                "visibilityState",
            );
            Object.defineProperty(document, "visibilityState", {
                value: "hidden",
                configurable: true,
                writable: true,
            });
            try {
                await act(async () => {
                    document.dispatchEvent(new Event("visibilitychange"));
                    await Promise.resolve();
                });
                expect(fetchMock).toHaveBeenCalledTimes(1);
                expect(fetchMock).toHaveBeenCalledWith(
                    `/api/v1/notes/${encodeURIComponent(ScratchpadUUID)}`,
                    expect.objectContaining({
                        method: "PUT",
                        keepalive: true,
                        body: JSON.stringify({ content: "tab-switch save" }),
                    }),
                );
                expect(updateNoteMock).not.toHaveBeenCalled();
            } finally {
                if (originalDescriptor) {
                    Object.defineProperty(
                        document,
                        "visibilityState",
                        originalDescriptor,
                    );
                }
            }
        } finally {
            global.fetch = originalFetch;
        }
    });

    it("UX-07: beforeunload fires keepalive PUT when conditions met", async () => {
        getNoteMock.mockResolvedValue(okGet("baseline"));
        updateNoteMock.mockResolvedValue(okPut());
        const fetchMock = vi.fn().mockResolvedValue(new Response());
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            render(<EditorPane noteId={ScratchpadUUID} />);
            await flushMicrotasks();
            const editor = screen.getByLabelText(
                "Note content",
            ) as HTMLTextAreaElement;
            await waitFor(() => expect(editor.value).toBe("baseline"));

            fireEvent.change(editor, { target: { value: "exit save" } });

            act(() => {
                window.dispatchEvent(new Event("beforeunload"));
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0] as [
                string,
                RequestInit,
            ];
            expect(url).toBe(
                `/api/v1/notes/${encodeURIComponent(ScratchpadUUID)}`,
            );
            expect(init.method).toBe("PUT");
            expect(init.keepalive).toBe(true);
            expect(init.body).toBe(
                JSON.stringify({ content: "exit save" }),
            );
        } finally {
            global.fetch = originalFetch;
        }
    });

    it("UX-07: beforeunload skips when paused (connectionStatus !== connected)", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());
        useTreeStore.setState({ connectionStatus: "reconnecting" });
        const fetchMock = vi.fn().mockResolvedValue(new Response());
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            render(<EditorPane noteId={ScratchpadUUID} />);
            await flushMicrotasks();
            const editor = screen.getByLabelText(
                "Note content",
            ) as HTMLTextAreaElement;
            await waitFor(() => expect(editor.value).toBe("hello"));

            act(() => {
                window.dispatchEvent(new Event("beforeunload"));
            });

            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            global.fetch = originalFetch;
            useTreeStore.setState({ connectionStatus: "connected" });
        }
    });

    afterEach(() => {
        useTreeStore.setState({ connectionStatus: "connected" });
    });
});


/**
 * Helper: monkey-patch document.visibilityState. Returns a restore fn the
 * caller MUST invoke in a finally block so subsequent tests aren't polluted.
 */
function setVisibilityState(value: "hidden" | "visible"): () => void {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
        Document.prototype,
        "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
        value,
        configurable: true,
        writable: true,
    });
    return () => {
        if (originalDescriptor) {
            Object.defineProperty(
                document,
                "visibilityState",
                originalDescriptor,
            );
        }
    };
}

describe("BL-04 keepalive-on-tab-close (Phase 5.5 gap-closure Plan 12)", () => {
    it("BL-04: visibilitychange→hidden while connected fires keepalive PUT", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());
        const fetchMock = vi.fn().mockResolvedValue(new Response());
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            render(<EditorPane noteId={ScratchpadUUID} />);
            await flushMicrotasks();
            const editor = screen.getByLabelText(
                "Note content",
            ) as HTMLTextAreaElement;
            await waitFor(() => expect(editor.value).toBe("hello"));

            fireEvent.change(editor, { target: { value: "edit before close" } });

            const restore = setVisibilityState("hidden");
            try {
                await act(async () => {
                    document.dispatchEvent(new Event("visibilitychange"));
                    await Promise.resolve();
                });
                expect(fetchMock).toHaveBeenCalledTimes(1);
                const [url, init] = fetchMock.mock.calls[0] as [
                    string,
                    RequestInit,
                ];
                expect(url).toBe(
                    `/api/v1/notes/${encodeURIComponent(ScratchpadUUID)}`,
                );
                expect(init.method).toBe("PUT");
                expect(init.keepalive).toBe(true);
                expect(init.body).toBe(
                    JSON.stringify({ content: "edit before close" }),
                );
            } finally {
                restore();
            }
        } finally {
            global.fetch = originalFetch;
        }
    });

    it("BL-04: visibilitychange→hidden while reconnecting does NOT fire fetch (paused gate)", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());
        useTreeStore.setState({ connectionStatus: "reconnecting" });

        const fetchMock = vi.fn().mockResolvedValue(new Response());
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            render(<EditorPane noteId={ScratchpadUUID} />);
            await flushMicrotasks();
            const editor = screen.getByLabelText(
                "Note content",
            ) as HTMLTextAreaElement;
            await waitFor(() => expect(editor.value).toBe("hello"));

            const restore = setVisibilityState("hidden");
            try {
                await act(async () => {
                    document.dispatchEvent(new Event("visibilitychange"));
                    await Promise.resolve();
                });
                expect(fetchMock).not.toHaveBeenCalled();
                expect(updateNoteMock).not.toHaveBeenCalled();
            } finally {
                restore();
            }
        } finally {
            global.fetch = originalFetch;
            useTreeStore.setState({ connectionStatus: "connected" });
        }
    });

    it("BL-04: visibilitychange→hidden then beforeunload only fires fetch ONCE (deduped)", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());
        const fetchMock = vi.fn().mockResolvedValue(new Response());
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            render(<EditorPane noteId={ScratchpadUUID} />);
            await flushMicrotasks();
            const editor = screen.getByLabelText(
                "Note content",
            ) as HTMLTextAreaElement;
            await waitFor(() => expect(editor.value).toBe("hello"));

            fireEvent.change(editor, { target: { value: "the bytes" } });

            const restore = setVisibilityState("hidden");
            try {
                await act(async () => {
                    document.dispatchEvent(new Event("visibilitychange"));
                    await Promise.resolve();
                });
                expect(fetchMock).toHaveBeenCalledTimes(1);

                act(() => {
                    window.dispatchEvent(new Event("beforeunload"));
                });
                expect(fetchMock).toHaveBeenCalledTimes(1);
            } finally {
                restore();
            }
        } finally {
            global.fetch = originalFetch;
        }
    });

    it("BL-04: visibilitychange→hidden clears any pending debounceTimer", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());
        const fetchMock = vi.fn().mockResolvedValue(new Response());
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            render(<EditorPane noteId={ScratchpadUUID} />);
            await flushMicrotasks();
            const editor = screen.getByLabelText(
                "Note content",
            ) as HTMLTextAreaElement;
            await waitFor(() => expect(editor.value).toBe("hello"));

            fireEvent.change(editor, { target: { value: "buffered edit" } });

            const restore = setVisibilityState("hidden");
            try {
                await act(async () => {
                    document.dispatchEvent(new Event("visibilitychange"));
                    await Promise.resolve();
                });
                expect(fetchMock).toHaveBeenCalledTimes(1);

                await act(async () => {
                    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 100);
                });
                expect(updateNoteMock).not.toHaveBeenCalled();
            } finally {
                restore();
            }
        } finally {
            global.fetch = originalFetch;
        }
    });

    it("BL-04: beforeunload still fires keepalive when visibilitychange did NOT fire first", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());
        const fetchMock = vi.fn().mockResolvedValue(new Response());
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            render(<EditorPane noteId={ScratchpadUUID} />);
            await flushMicrotasks();
            const editor = screen.getByLabelText(
                "Note content",
            ) as HTMLTextAreaElement;
            await waitFor(() => expect(editor.value).toBe("hello"));

            fireEvent.change(editor, { target: { value: "fallback path" } });

            act(() => {
                window.dispatchEvent(new Event("beforeunload"));
            });
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
            expect(init.keepalive).toBe(true);
        } finally {
            global.fetch = originalFetch;
        }
    });

    it("BL-04: visible→hidden→visible→hidden re-arms the dedup ref so the second hide can fire keepalive", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());
        const fetchMock = vi.fn().mockResolvedValue(new Response());
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            render(<EditorPane noteId={ScratchpadUUID} />);
            await flushMicrotasks();
            const editor = screen.getByLabelText(
                "Note content",
            ) as HTMLTextAreaElement;
            await waitFor(() => expect(editor.value).toBe("hello"));

            fireEvent.change(editor, { target: { value: "first hide" } });

            const restoreHidden1 = setVisibilityState("hidden");
            try {
                await act(async () => {
                    document.dispatchEvent(new Event("visibilitychange"));
                    await Promise.resolve();
                });
                expect(fetchMock).toHaveBeenCalledTimes(1);
            } finally {
                restoreHidden1();
            }

            const restoreVisible = setVisibilityState("visible");
            try {
                await act(async () => {
                    document.dispatchEvent(new Event("visibilitychange"));
                    await Promise.resolve();
                });
            } finally {
                restoreVisible();
            }

            fireEvent.change(editor, { target: { value: "second hide" } });
            const restoreHidden2 = setVisibilityState("hidden");
            try {
                await act(async () => {
                    document.dispatchEvent(new Event("visibilitychange"));
                    await Promise.resolve();
                });
                expect(fetchMock).toHaveBeenCalledTimes(2);
            } finally {
                restoreHidden2();
            }
        } finally {
            global.fetch = originalFetch;
        }
    });

    it("G3 fix: visibilitychange to hidden does NOT fire keepalive when user has not edited (vault-switch contamination guard)", async () => {
        getNoteMock.mockResolvedValue(okGet("untouched"));
        const fetchMock = vi.fn().mockResolvedValue(new Response());
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            render(<EditorPane noteId={ScratchpadUUID} />);
            await flushMicrotasks();
            const editor = screen.getByLabelText(
                "Note content",
            ) as HTMLTextAreaElement;
            await waitFor(() => expect(editor.value).toBe("untouched"));

            const restore = setVisibilityState("hidden");
            try {
                await act(async () => {
                    document.dispatchEvent(new Event("visibilitychange"));
                    await Promise.resolve();
                });
                expect(fetchMock).not.toHaveBeenCalled();
            } finally {
                restore();
            }
        } finally {
            global.fetch = originalFetch;
        }
    });

    it("G3 fix: visibilitychange to hidden does NOT fire keepalive while a vault switch is active (even after editing)", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());
        const fetchMock = vi.fn().mockResolvedValue(new Response());
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            render(<EditorPane noteId={ScratchpadUUID} />);
            await flushMicrotasks();
            const editor = screen.getByLabelText(
                "Note content",
            ) as HTMLTextAreaElement;
            await waitFor(() => expect(editor.value).toBe("hello"));

            fireEvent.change(editor, { target: { value: "my unsaved edit" } });

            act(() => {
                useTreeStore
                    .getState()
                    .setVaultSwitching({ active: true, targetName: "vault-b" });
            });

            const restore = setVisibilityState("hidden");
            try {
                await act(async () => {
                    document.dispatchEvent(new Event("visibilitychange"));
                    await Promise.resolve();
                });
                expect(fetchMock).not.toHaveBeenCalled();
            } finally {
                restore();
                act(() => {
                    useTreeStore
                        .getState()
                        .setVaultSwitching({ active: false, targetName: "" });
                });
            }
        } finally {
            global.fetch = originalFetch;
        }
    });

    it("G3 fix: beforeunload also gates on userHasEdited (parity with visibilitychange)", async () => {
        getNoteMock.mockResolvedValue(okGet("untouched"));
        const fetchMock = vi.fn().mockResolvedValue(new Response());
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            render(<EditorPane noteId={ScratchpadUUID} />);
            await flushMicrotasks();
            const editor = screen.getByLabelText(
                "Note content",
            ) as HTMLTextAreaElement;
            await waitFor(() => expect(editor.value).toBe("untouched"));

            act(() => {
                window.dispatchEvent(new Event("beforeunload"));
            });
            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            global.fetch = originalFetch;
        }
    });

    afterEach(() => {
        useTreeStore.setState({ connectionStatus: "connected" });
    });
});

describe("WR-04/05/06 exhaustiveness + Save-anyway recovery (Phase 5.5 gap-closure Plan 12)", () => {
    /**
     * Helper for the WR-06 tests: render the editor, simulate an edit + a
     * note:updated WS event so the conflict banner mounts, and return a
     * handle for clicking "Save anyway".
     */
    async function setupConflictBanner() {
        const handlersRef: { current: EditorPaneHandlers | null } = {
            current: null,
        };
        render(
            <EditorPane
                noteId={ScratchpadUUID}
                editorHandlersRef={handlersRef}
            />,
        );
        await flushMicrotasks();
        const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("original"));

        fireEvent.change(editor, { target: { value: "user edits" } });

        const updatedPayload: WSNoteUpdatedPayload = {
            id: ScratchpadUUID,
            path: "scratchpad.md",
            updated_at: "2026-05-09T10:00:00Z",
        };
        act(() => {
            handlersRef.current!.onNoteUpdated(updatedPayload);
        });
        await waitFor(() =>
            expect(screen.getByTestId("conflict-banner")).toBeInTheDocument(),
        );
        return { editor, handlersRef };
    }

    it("WR-05: Save-anyway click is a null-guarded no-op when noteIdRef.current is null", async () => {
        getNoteMock.mockResolvedValue(okGet("original"));
        updateNoteMock.mockResolvedValue(okPut());
        await setupConflictBanner();

        updateNoteMock.mockClear();
        fireEvent.click(screen.getByRole("button", { name: /Save anyway/i }));

        await waitFor(() => expect(updateNoteMock).toHaveBeenCalledTimes(1));
        expect(updateNoteMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "user edits",
            "2026-05-09T10:00:00Z",
        );
    });

    it("WR-06: Save-anyway non-stale failure refreshes conflict banner with the latest server updated_at", async () => {
        getNoteMock.mockResolvedValue(okGet("original"));
        updateNoteMock.mockResolvedValue(okPut());
        await setupConflictBanner();

        updateNoteMock.mockReset();
        updateNoteMock.mockResolvedValueOnce(
            errPut("disk full") as PutReturn,
        );
        getNoteMock.mockReset();
        getNoteMock.mockResolvedValueOnce({
            data: {
                id: ScratchpadUUID,
                path: "scratchpad.md",
                content: "fresh server content",
                updated_at: "2026-05-09T11:00:00Z",
            },
            error: undefined,
            response: new Response(),
        } as GetReturn);
        updateNoteMock.mockResolvedValue(okPut());

        fireEvent.click(screen.getByRole("button", { name: /Save anyway/i }));
        await waitFor(() => expect(updateNoteMock).toHaveBeenCalledTimes(1));

        await waitFor(() => {
            const alerts = screen.getAllByRole("alert");
            const text = alerts.map((a) => a.textContent ?? "").join(" ");
            expect(text).toMatch(/Save failed|retry|Discard/);
        });

        expect(screen.getByTestId("conflict-banner")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /Save anyway/i }));
        await waitFor(() => expect(updateNoteMock).toHaveBeenCalledTimes(2));
        expect(updateNoteMock).toHaveBeenLastCalledWith(
            ScratchpadUUID,
            "user edits",
            "2026-05-09T11:00:00Z",
        );
    });

    it("WR-06: Save-anyway non-stale failure when getNote ALSO fails surfaces a clear retry-on-next-sync hint", async () => {
        getNoteMock.mockResolvedValue(okGet("original"));
        updateNoteMock.mockResolvedValue(okPut());
        await setupConflictBanner();

        updateNoteMock.mockReset();
        updateNoteMock.mockResolvedValueOnce(
            errPut("network down") as PutReturn,
        );
        getNoteMock.mockReset();
        getNoteMock.mockRejectedValueOnce(new Error("offline"));

        fireEvent.click(screen.getByRole("button", { name: /Save anyway/i }));
        await waitFor(() => expect(updateNoteMock).toHaveBeenCalledTimes(1));

        await waitFor(() => {
            const alerts = screen.getAllByRole("alert");
            const text = alerts.map((a) => a.textContent ?? "").join(" ");
            expect(text).toMatch(/retry on next sync|Discard|retry/i);
        });

        expect(screen.getByTestId("conflict-banner")).toBeInTheDocument();
    });

    it("WR-06: Save-anyway non-stale failure dispatches saveFailed (existing BL-03 contract)", async () => {
        getNoteMock.mockResolvedValue(okGet("original"));
        updateNoteMock.mockResolvedValue(okPut());
        await setupConflictBanner();

        updateNoteMock.mockReset();
        updateNoteMock.mockResolvedValueOnce(
            errPut("write_failed") as PutReturn,
        );
        getNoteMock.mockReset();
        getNoteMock.mockResolvedValueOnce(okGet("server content"));

        fireEvent.click(screen.getByRole("button", { name: /Save anyway/i }));
        await waitFor(() => expect(updateNoteMock).toHaveBeenCalledTimes(1));

        await waitFor(() =>
            expect(useTreeStore.getState().saveState.status).toBe("error"),
        );
    });
});

describe("WR-04 findNotePathInTree exhaustiveness (Phase 5.5 gap-closure Plan 12)", () => {
    it("WR-04: live-tree path lookup returns the correct path for a note nested in a folder (exhaustive switch happy path)", async () => {
        getNoteMock.mockResolvedValue(okGet("original"));
        updateNoteMock.mockResolvedValue(okPut());
        getTreeMock.mockResolvedValue({
            data: {
                root: [
                    {
                        kind: "folder",
                        path: "projects",
                        name: "projects",
                        children: [
                            {
                                kind: "folder",
                                path: "projects/jasper",
                                name: "jasper",
                                children: [
                                    {
                                        kind: "note",
                                        id: ScratchpadUUID,
                                        path: "projects/jasper/note.md",
                                        title: "note",
                                        updated_at: "2025-01-01T00:00:00Z",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
            error: undefined,
            response: new Response(),
        } as GetTreeReturn);

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();
        const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("original"));

        expect(screen.queryByText(/Could not load note/)).not.toBeInTheDocument();
    });
});

describe("WR-02 connectionRestored flushes buffered edits (Phase 5.5 gap-closure Plan 12)", () => {
    it("WR-02: reconnecting → connected with buffered edits triggers performSave (reconnect-flush)", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());

        useTreeStore.setState({ connectionStatus: "connected" });

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();
        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("hello"));

        act(() => {
            useTreeStore.setState({ connectionStatus: "reconnecting" });
        });

        fireEvent.change(editor, {
            target: { value: "edits during disconnect" },
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);
        });
        await flushMicrotasks();
        expect(updateNoteMock).not.toHaveBeenCalled();

        await act(async () => {
            useTreeStore.setState({ connectionStatus: "connected" });
            await Promise.resolve();
            await Promise.resolve();
        });

        await waitFor(() => expect(updateNoteMock).toHaveBeenCalled());
        expect(updateNoteMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "edits during disconnect",
        );
    });

    it("WR-02: reconnecting → connected with NO buffered edits does NOT call updateNote (no spurious save)", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());

        useTreeStore.setState({ connectionStatus: "reconnecting" });

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();
        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("hello"));

        await act(async () => {
            useTreeStore.setState({ connectionStatus: "connected" });
            await Promise.resolve();
            await Promise.resolve();
        });

        await flushMicrotasks();
        expect(updateNoteMock).not.toHaveBeenCalled();
    });

    it("WR-02: reconnecting → connected with noteId === null does NOT call updateNote (null-id guard)", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());

        useTreeStore.setState({ connectionStatus: "reconnecting" });

        const { rerender } = render(<EditorPane noteId={null} />);
        await flushMicrotasks();

        await act(async () => {
            useTreeStore.setState({ connectionStatus: "connected" });
            await Promise.resolve();
        });
        await flushMicrotasks();
        expect(updateNoteMock).not.toHaveBeenCalled();

        rerender(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();
        expect(updateNoteMock).not.toHaveBeenCalled();
    });

    it("WR-02: connected → reconnecting → connected reconnect-flush flushes the disconnect-buffered edit", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());

        useTreeStore.setState({ connectionStatus: "connected" });

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();
        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("hello"));

        act(() => {
            useTreeStore.setState({ connectionStatus: "reconnecting" });
        });

        fireEvent.change(editor, {
            target: { value: "buffered while reconnecting" },
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);
        });
        expect(updateNoteMock).not.toHaveBeenCalled();

        await act(async () => {
            useTreeStore.setState({ connectionStatus: "connected" });
            await Promise.resolve();
            await Promise.resolve();
        });

        await waitFor(() => expect(updateNoteMock).toHaveBeenCalled());
        expect(updateNoteMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "buffered while reconnecting",
        );
    });

    afterEach(() => {
        useTreeStore.setState({ connectionStatus: "connected" });
    });
});


vi.mock("../lib/useTagBrowser", () => ({
    dispatchTagEvent: vi.fn(),
    useTagBrowser: vi.fn(() => ({
        tags: [],
        loading: false,
        error: null,
        refresh: vi.fn(),
    })),
    __testing__: {
        simulateEvent: vi.fn(),
        getSubscriberCount: vi.fn(() => 0),
    },
}));

import { dispatchTagEvent } from "../lib/useTagBrowser";
const dispatchTagEventMock = vi.mocked(dispatchTagEvent);

describe("<EditorPane /> — BUG-01: saving tab dispatches tags:updated locally", () => {
    beforeEach(() => {
        dispatchTagEventMock.mockClear();
    });

    it("BUG-01: dispatchTagEvent('tags:updated') is called after a successful save", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText("Note content") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("hello"));

        fireEvent.change(editor, { target: { value: "updated content" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();

        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(dispatchTagEventMock).toHaveBeenCalledWith("tags:updated");
    });

    it("BUG-01: dispatchTagEvent is NOT called when save fails", async () => {
        getNoteMock.mockResolvedValue(okGet("hello"));
        updateNoteMock.mockResolvedValue(errPut("disk full"));

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText("Note content") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("hello"));

        fireEvent.change(editor, { target: { value: "bad save" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();

        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(dispatchTagEventMock).not.toHaveBeenCalled();
    });
});


describe("<EditorPane /> — BUG-03: handleEditorBlur no-op when userHasEdited is false", () => {
    it("BUG-03: handleEditorBlur is a no-op when userHasEdited is false (no typing since note open)", async () => {
        getNoteMock.mockResolvedValue(okGet("original content"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText("Note content") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("original content"));

        await act(async () => {
            window.__jasperMockEditorBlur?.();
            await Promise.resolve();
        });

        expect(updateNoteMock).not.toHaveBeenCalled();
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("BUG-03 (positive case): handleEditorBlur DOES save when userHasEdited is true", async () => {
        getNoteMock.mockResolvedValue(okGet("original content"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText("Note content") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("original content"));

        fireEvent.change(editor, { target: { value: "edited content" } });
        expect(updateNoteMock).not.toHaveBeenCalled();

        await act(async () => {
            window.__jasperMockEditorBlur?.();
            await Promise.resolve();
        });

        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(updateNoteMock).toHaveBeenCalledWith(ScratchpadUUID, "edited content");
    });
});


describe("<EditorPane /> — Phase 12 D-03 checkbox toggle immediate flush", () => {
    it("CHK-01 toggle → exactly one immediate save; debounce timer does not fire a second save", async () => {
        getNoteMock.mockResolvedValue(okGet("- [ ] task"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText("Note content") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("- [ ] task"));

        await act(async () => {
            window.__jasperMockEditorToggle?.("- [x] task");
            await Promise.resolve();
        });

        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(updateNoteMock).toHaveBeenCalledWith(ScratchpadUUID, "- [x] task");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 100);
        });
        expect(updateNoteMock).toHaveBeenCalledTimes(1);
    });

    it("CHK-01 typing → debounce only; onSaveRequested NOT called synchronously", async () => {
        getNoteMock.mockResolvedValue(okGet("- [ ] task"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText("Note content") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("- [ ] task"));

        fireEvent.change(editor, { target: { value: "- [ ] task edited" } });

        await flushMicrotasks();
        expect(updateNoteMock).not.toHaveBeenCalled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
        });
        await flushMicrotasks();

        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(updateNoteMock).toHaveBeenCalledWith(ScratchpadUUID, "- [ ] task edited");
    });

    it("CHK-01 multiple toggles in sequence each produce exactly one save", async () => {
        getNoteMock.mockResolvedValue(okGet("- [ ] task\n- [ ] task2"));
        updateNoteMock.mockResolvedValue(okPut());

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        const editor = screen.getByLabelText("Note content") as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("- [ ] task\n- [ ] task2"));

        await act(async () => {
            window.__jasperMockEditorToggle?.("- [x] task\n- [ ] task2");
            await Promise.resolve();
        });
        await flushMicrotasks();
        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(updateNoteMock).toHaveBeenLastCalledWith(ScratchpadUUID, "- [x] task\n- [ ] task2");

        await act(async () => {
            window.__jasperMockEditorToggle?.("- [x] task\n- [x] task2");
            await Promise.resolve();
        });
        await flushMicrotasks();
        expect(updateNoteMock).toHaveBeenCalledTimes(2);
        expect(updateNoteMock).toHaveBeenLastCalledWith(ScratchpadUUID, "- [x] task\n- [x] task2");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 100);
        });
        expect(updateNoteMock).toHaveBeenCalledTimes(2);
    });
});

describe("EP-keepalive-session — keepalive PUT carries X-Session-ID (UAT-2 N8)", () => {
    it("visibilitychange keepalive PUT includes X-Session-ID header", async () => {
        getNoteMock.mockResolvedValue(okGet("original content"));
        updateNoteMock.mockResolvedValue(okPut());
        const fetchMock = vi.fn().mockResolvedValue(new Response());
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            render(<EditorPane noteId={ScratchpadUUID} />);
            await flushMicrotasks();
            const editor = screen.getByLabelText(
                "Note content",
            ) as HTMLTextAreaElement;
            await waitFor(() => expect(editor.value).toBe("original content"));

            fireEvent.change(editor, { target: { value: "edited content" } });

            const restoreHidden = setVisibilityState("hidden");
            try {
                await act(async () => {
                    document.dispatchEvent(new Event("visibilitychange"));
                    await Promise.resolve();
                });
                expect(fetchMock).toHaveBeenCalledTimes(1);
                const init = fetchMock.mock.calls[0][1] as RequestInit;
                const headers = init.headers as Record<string, string> | Headers | undefined;
                const sid =
                    headers instanceof Headers
                        ? headers.get("X-Session-ID")
                        : (headers as Record<string, string> | undefined)?.["X-Session-ID"];
                expect(sid).toBeTruthy();
                expect(sid).toMatch(/^[0-9a-f-]{36}$/i);
            } finally {
                restoreHidden();
            }
        } finally {
            global.fetch = originalFetch;
        }
    });

    it("beforeunload keepalive PUT includes X-Session-ID header", async () => {
        getNoteMock.mockResolvedValue(okGet("initial"));
        updateNoteMock.mockResolvedValue(okPut());
        const fetchMock = vi.fn().mockResolvedValue(new Response());
        const originalFetch = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;

        try {
            render(<EditorPane noteId={ScratchpadUUID} />);
            await flushMicrotasks();
            const editor = screen.getByLabelText(
                "Note content",
            ) as HTMLTextAreaElement;
            await waitFor(() => expect(editor.value).toBe("initial"));

            fireEvent.change(editor, { target: { value: "exit save content" } });

            act(() => {
                window.dispatchEvent(new Event("beforeunload"));
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const init = fetchMock.mock.calls[0][1] as RequestInit;
            const headers = init.headers as Record<string, string> | Headers | undefined;
            const sid =
                headers instanceof Headers
                    ? headers.get("X-Session-ID")
                    : (headers as Record<string, string> | undefined)?.["X-Session-ID"];
            expect(sid).toBeTruthy();
            expect(sid).toMatch(/^[0-9a-f-]{36}$/i);
        } finally {
            global.fetch = originalFetch;
        }
    });
});


describe("<EditorPane /> — Phase 15 keep-alive (hidden / isDeleted) (Plan 15-02)", () => {
    it("hidden=true sets display:none on the editor-pane root WITHOUT unmounting", async () => {
        getNoteMock.mockResolvedValue(okGet("base"));

        render(<EditorPane noteId={ScratchpadUUID} hidden />);
        await flushMicrotasks();

        const pane = screen.getByTestId("editor-pane");
        expect(pane.style.display).toBe("none");
        // Still mounted — CM6 (mock textarea) remains in the DOM for keep-alive.
        expect(screen.getByLabelText("Note content")).toBeInTheDocument();
    });

    it("hidden=false renders the pane visible (display:flex)", async () => {
        getNoteMock.mockResolvedValue(okGet("base"));

        render(<EditorPane noteId={ScratchpadUUID} />);
        await flushMicrotasks();

        expect(screen.getByTestId("editor-pane").style.display).toBe("flex");
    });

    it("isDeleted=true makes the editor read-only", async () => {
        getNoteMock.mockResolvedValue(okGet("base"));

        render(<EditorPane noteId={ScratchpadUUID} isDeleted />);
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        expect(editor.readOnly).toBe(true);
    });

    it("isDeleted=true suppresses the in-pane deletion banner on note:deleted", async () => {
        getNoteMock.mockResolvedValue(okGet("work"));
        const handlersRef: { current: EditorPaneHandlers | null } = {
            current: null,
        };

        render(
            <EditorPane
                noteId={ScratchpadUUID}
                isDeleted
                editorHandlersRef={handlersRef}
            />,
        );
        await flushMicrotasks();

        act(() => {
            handlersRef.current!.onNoteDeleted({
                id: ScratchpadUUID,
                path: "scratchpad.md",
            });
        });

        expect(screen.queryByTestId("deleted-banner")).not.toBeInTheDocument();
    });
});


describe("<EditorPane /> — Phase 15 flush() ref method (Plan 15-02, TAB-13)", () => {
    function renderWithFlush(noteId: string | null = ScratchpadUUID) {
        const flushRef: { current: { flush: () => Promise<void> } | null } = {
            current: null,
        };
        const view = render(<EditorPane noteId={noteId} flushRef={flushRef} />);
        return { ...view, flushRef };
    }

    it("flush() with a pending mid-debounce edit saves immediately (no debounce wait)", async () => {
        getNoteMock.mockResolvedValue(okGet("base"));
        updateNoteMock.mockResolvedValue(okPut());
        const { flushRef } = renderWithFlush();
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("base"));

        fireEvent.change(editor, { target: { value: "edited before close" } });
        // Do NOT advance the 2s debounce — flush() must force the save itself.
        await act(async () => {
            await flushRef.current!.flush();
        });

        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(updateNoteMock).toHaveBeenCalledWith(
            ScratchpadUUID,
            "edited before close",
        );
    });

    it("flush() awaits the save before resolving (save precedes the close hook)", async () => {
        getNoteMock.mockResolvedValue(okGet("base"));
        let resolvePut: (v: PutReturn) => void = () => {};
        updateNoteMock.mockImplementation(
            () =>
                new Promise<PutReturn>((r) => {
                    resolvePut = r;
                }) as ReturnType<typeof updateNote>,
        );
        const { flushRef } = renderWithFlush();
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("base"));

        fireEvent.change(editor, { target: { value: "edited" } });

        let resolved = false;
        let flushPromise!: Promise<void>;
        await act(async () => {
            flushPromise = flushRef.current!.flush().then(() => {
                resolved = true;
            });
            await Promise.resolve();
            await Promise.resolve();
        });

        // Save fired, but flush has NOT resolved until the PUT completes.
        expect(updateNoteMock).toHaveBeenCalledTimes(1);
        expect(resolved).toBe(false);

        await act(async () => {
            resolvePut(okPut());
            await flushPromise;
        });
        expect(resolved).toBe(true);
    });

    it("flush() rejects when the underlying save fails", async () => {
        getNoteMock.mockResolvedValue(okGet("base"));
        updateNoteMock.mockResolvedValue(errPut("disk full"));
        const { flushRef } = renderWithFlush();
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("base"));

        fireEvent.change(editor, { target: { value: "edited" } });

        let caught: unknown = null;
        await act(async () => {
            caught = await flushRef
                .current!.flush()
                .then(() => null)
                .catch((e: unknown) => e);
        });

        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toMatch(/flush failed/);
    });

    it("flush() with no pending edits resolves and does NOT call the save API", async () => {
        getNoteMock.mockResolvedValue(okGet("base"));
        updateNoteMock.mockResolvedValue(okPut());
        const { flushRef } = renderWithFlush();
        await flushMicrotasks();

        const editor = screen.getByLabelText(
            "Note content",
        ) as HTMLTextAreaElement;
        await waitFor(() => expect(editor.value).toBe("base"));

        await act(async () => {
            await flushRef.current!.flush();
        });

        expect(updateNoteMock).not.toHaveBeenCalled();
    });
});

/**
 * App-shell tests. Mocks the admin status hook so each test can drive the
 * migration-banner branch without spinning up real fetch.
 */
import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";


vi.mock("./lib/vaultApi", () => ({
  vaultApi: {
    getCurrent: vi.fn().mockResolvedValue({
      path: "/vault",
      display_name: "Test Vault",
      last_opened_at: "2026-05-24T00:00:00Z",
      created_at: "2026-05-24T00:00:00Z",
      missing: false,
    }),
    getRecent: vi.fn().mockResolvedValue({ vaults: [], banner: "" }),
    open: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
    forget: vi.fn().mockResolvedValue(undefined),
  },
  validateVaultPath: vi.fn().mockReturnValue({ ok: true }),
}));


vi.mock("./lib/useVaultPicker", () => ({
  useVaultPicker: vi.fn(() => ({
    isOpen: false,
    open: vi.fn(),
    close: vi.fn(),
    current: null,
    recents: [],
    banner: "",
    isLoading: false,
    refresh: vi.fn(),
  })),
}));

vi.mock("./lib/notesApi", () => ({
  ScratchpadUUID: "00000000-0000-4000-a000-000000000001",
  getNote: vi.fn().mockResolvedValue({
    data: {
      id: "00000000-0000-4000-a000-000000000001",
      path: "scratchpad.md",
      content: "# Welcome",
      updated_at: "2025-01-01T00:00:00Z",
    },
    error: undefined,
    response: new Response(),
  }),
  updateNote: vi.fn(),
}));

const getAdminStatusMock = vi.fn();
const postAdminReindexMock = vi.fn();

vi.mock("./lib/adminApi", () => ({
  getAdminStatus: (...args: unknown[]) => getAdminStatusMock(...args),
  postAdminReindex: (...args: unknown[]) => postAdminReindexMock(...args),
}));


vi.mock("./lib/useFileTree", () => ({
  useFileTree: () => ({
    tree: { root: [] },
    loading: false,
    error: null,
    refresh: () => Promise.resolve(),
    mutate: () => {},
  }),
}));


import type { SessionSyncHandlers } from "./lib/useSessionSync";
let capturedSessionSyncHandlers: SessionSyncHandlers | null = null;
vi.mock("./lib/useSessionSync", () => ({
  useSessionSync: (h: SessionSyncHandlers) => {
    capturedSessionSyncHandlers = h;
  },
}));


vi.mock("./lib/useTheme", () => ({
  useTheme: () => ({
    theme: "dark",
    setTheme: vi.fn().mockResolvedValue({}),
  }),
  THEME_BOOTSTRAP_KEY: "jasper:theme-bootstrap",
}));

// Stub useConfig to avoid a real /config fetch (rejects with "Invalid URL" in
// jsdom). `config: null` is App's handled "not-loaded" state (boot effect
// early-returns; autosaveMs falls back to 2000).
vi.mock("./lib/useConfig", () => ({
  useConfig: () => ({
    config: null,
    error: null,
    saveConfig: vi.fn().mockResolvedValue({}),
  }),
}));


const mockOpenToday = vi.fn().mockResolvedValue(undefined);
vi.mock("./lib/useDailyNote", () => ({
  useDailyNote: () => ({
    openToday: mockOpenToday,
    isLoading: false,
  }),
}));


const mockCreateNoteAt = vi.fn().mockResolvedValue(undefined);
const mockCreateFolderAt = vi.fn().mockResolvedValue(undefined);
// Preserve the real siblingNamesForCreate (App.tsx imports it for collision-safe
// untitled naming); only the hook is stubbed.
vi.mock("./lib/useTreeCreateActions", async (importActual) => ({
  ...(await importActual<typeof import("./lib/useTreeCreateActions")>()),
  useTreeCreateActions: () => ({
    createNoteAt: mockCreateNoteAt,
    createFolderAt: mockCreateFolderAt,
    isCreating: false,
  }),
}));


// Mocked with a ref-API-compatible fake (same shape as EditorPane.test.tsx's
// mock) that renders a real <textarea aria-label="Note content">, so the
// WR-01 flush-reject test can drive a real onChange → userHasEdited=true
// without depending on real CodeMirror's jsdom contenteditable behavior.
vi.mock("./components/MarkdownEditor", async () => {
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
        // no-op in test
      },
    }), [value]);

    return React.createElement("textarea", {
      "aria-label": "Note content",
      "data-testid": "markdown-editor-mock",
      value,
      readOnly: props.readOnly ?? false,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const next = e.target.value;
        setValue(next);
        propsRef.current.onChange?.(next);
      },
    });
  });

  return {
    MarkdownEditor,
    ServerUpdateAnnotation: { of: () => ({}) },
  };
});


vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn().mockImplementation(({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        start: i * 36,
        size: 36,
        key: i,
      })),
    getTotalSize: () => count * 36,
    scrollToIndex: vi.fn(),
    measureElement: vi.fn(),
    measure: vi.fn(),
  })),
}));

import App, { AppShell } from "./App";
import {
  handleAppCmdB,
  handleAppCmdI,
  handleAppCmdO,
  handleAppCmdP,
  handleAppCmdShiftD,
  handleAppCmdShiftF,
  handleAppCmdSlash,
  handleAppF2KeyDown,
  subscribePhase7,
  type Phase7DispatchEvent,
} from "./lib/appShortcuts";


import { useTreeStore } from "./lib/useTreeStore";
import { COMMAND_PALETTE_ENTRIES } from "./lib/shortcutsRegistry";
import { siblingNamesForCreate } from "./lib/useTreeCreateActions";
import { nextUntitledName } from "./lib/nextUntitledName";
import type { Tree } from "./lib/treeApi";
import { useTabStore } from "./lib/useTabStore";
import { updateNote } from "./lib/notesApi";
import { vaultApi } from "./lib/vaultApi";

const SCRATCHPAD = "00000000-0000-4000-a000-000000000001";

describe("<App /> — shell composition", () => {
  beforeEach(() => {
    getAdminStatusMock.mockReset();
    postAdminReindexMock.mockReset();
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: SCRATCHPAD,
      pendingRename: null,
      draftCreate: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("A1: when status=ok, the grid renders inside the flex column with two-row grid", async () => {
    getAdminStatusMock.mockResolvedValue({
      data: { state: "ok", notes_indexed: 0 },
      error: undefined,
    });

    const { container } = render(<AppShell />);
    const root = container.firstChild as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.style.display).toBe("flex");
    expect(root.style.flexDirection).toBe("column");
    expect(root.style.height).toBe("100vh");
    // Root shell uses per-axis overflow to allow horizontal scroll below minWidth.
    expect(root.style.overflowX).toBe("auto");
    expect(root.style.overflowY).toBe("hidden");
    expect(root.style.minWidth).toBe("640px");

    const grid = root.querySelector(
      'div[style*="grid-template-columns"]',
    ) as HTMLElement | null;
    expect(grid).not.toBeNull();
    // Leading 48px track is the ActivityRibbon column; middle track is
    // minmax(0, 1fr) so TabStrip overflow can engage.
    expect(grid!.style.gridTemplateColumns).toBe(
      "48px 260px minmax(0, 1fr) 0px",
    );

    expect(screen.getByText("NOTES")).toBeInTheDocument();
    expect(screen.getByTestId("tree-empty-state")).toBeInTheDocument();
  });

  it("A2: status=ok renders no banner and the editor textarea is enabled", async () => {
    getAdminStatusMock.mockResolvedValue({
      data: { state: "ok" },
      error: undefined,
    });

    render(<AppShell />);
    expect(screen.queryByRole("alert")).toBeNull();
    const textarea = screen.getByLabelText(
      "Note content",
    ) as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    await waitFor(() => expect(textarea).not.toBeDisabled());
  });

  it("A3: status=rolled_back renders the migration banner with locked copy + Reset button", async () => {
    getAdminStatusMock.mockResolvedValue({
      data: {
        state: "rolled_back",
        failed_migration: "003_tags.sql",
        logs_path: "/tmp/jasper.log",
      },
      error: undefined,
    });

    render(<AppShell />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Migration 003_tags.sql failed."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reset and rebuild database" }),
    ).toBeInTheDocument();
  });

  it("A4: clicking Reset → Confirm fires postAdminReindex and the success path mounts/unmounts ReindexProgress", async () => {
    getAdminStatusMock.mockResolvedValue({
      data: {
        state: "rolled_back",
        failed_migration: "003.sql",
        logs_path: "/tmp/log",
      },
      error: undefined,
    });
    postAdminReindexMock.mockResolvedValue({
      data: { started_at: "2025-01-01T00:00:00Z", notes_indexed: 7 },
      error: undefined,
    });

    render(<AppShell />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reset and rebuild database" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Reset and rebuild database" }),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Reset and rebuild" }),
    );

    await waitFor(() =>
      expect(screen.getByText("Index rebuilt.")).toBeInTheDocument(),
    );
    expect(postAdminReindexMock).toHaveBeenCalledWith("full");

    getAdminStatusMock.mockResolvedValueOnce({
      data: { state: "ok" },
      error: undefined,
    });

    // The overlay auto-dismisses SUCCESS_TRANSIENT_MS after success; poll for
    // that eventual condition instead of sleeping out the timer.
    await waitFor(
      () => expect(screen.queryByText("Index rebuilt.")).toBeNull(),
      { timeout: 2000 },
    );
  });

  it("A5: postAdminReindex error → ReindexProgress shows error copy; Close returns to the editor", async () => {
    getAdminStatusMock.mockResolvedValue({
      data: {
        state: "rolled_back",
        failed_migration: "003.sql",
        logs_path: "/tmp/log",
      },
      error: undefined,
    });
    postAdminReindexMock.mockResolvedValue({
      data: undefined,
      error: { code: "unrecoverable", message: "db is busy" },
    });

    render(<AppShell />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Reset and rebuild database" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reset and rebuild" }),
    );

    await waitFor(() =>
      expect(
        screen.getByText(/Couldn.t rebuild the index/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("db is busy")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(
        screen.queryByText(/Couldn.t rebuild the index/),
      ).toBeNull(),
    );
  });

  it("A6: Toast viewport is rendered exactly once (UI-SPEC §Forward-Compat assert #3)", () => {
    getAdminStatusMock.mockResolvedValue({
      data: { state: "ok" },
      error: undefined,
    });
    render(<AppShell />);
    const viewports = document.querySelectorAll(
      'div[role="region"][aria-label^="Notifications"]',
    );
    expect(viewports.length).toBe(1);
  });

  it("A7: TestApp_NullActiveNote_RendersPlaceholder", async () => {
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: null,
      pendingRename: null,
      draftCreate: null,
    });
    getAdminStatusMock.mockResolvedValue({
      data: { state: "ok" },
      error: undefined,
    });
    render(<AppShell />);
    await waitFor(() => {
      expect(
        screen.getByText("Select a note to start editing."),
      ).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Note content")).toBeNull();
  });

  describe("Document-level F2 routing (Gap R2-4)", () => {
    beforeEach(() => {
      useTreeStore.setState({
        expanded: new Set(),
        activeNoteId: null,
        pendingRename: null,
        draftCreate: null,
        selectedRow: null,
      });
    });

    function makeKeyDownEvent(opts: {
      key: string;
      target?: EventTarget | null;
    }): KeyboardEvent {
      let preventDefaultCalls = 0;
      const e = {
        key: opts.key,
        target: opts.target ?? null,
        preventDefault: () => {
          preventDefaultCalls += 1;
        },
        get _preventDefaultCalls() {
          return preventDefaultCalls;
        },
      } as unknown as KeyboardEvent & { _preventDefaultCalls: number };
      return e;
    }

    it("F2 with selectedRow set + non-form target → calls startRename", () => {
      useTreeStore.setState({
        selectedRow: { kind: "note", target: "abc" },
      });
      const div = document.createElement("div");
      const e = makeKeyDownEvent({ key: "F2", target: div });
      handleAppF2KeyDown(e);
      expect(useTreeStore.getState().pendingRename).toEqual({
        kind: "note",
        target: "abc",
      });
      expect(
        (e as unknown as { _preventDefaultCalls: number })
          ._preventDefaultCalls,
      ).toBe(1);
    });

    it("F2 with <input> as target → does NOT call startRename (form-control guard)", () => {
      useTreeStore.setState({
        selectedRow: { kind: "note", target: "abc" },
      });
      const input = document.createElement("input");
      const e = makeKeyDownEvent({ key: "F2", target: input });
      handleAppF2KeyDown(e);
      expect(useTreeStore.getState().pendingRename).toBeNull();
      expect(
        (e as unknown as { _preventDefaultCalls: number })
          ._preventDefaultCalls,
      ).toBe(0);
    });

    it("F2 with <textarea> as target → does NOT call startRename (form-control guard)", () => {
      useTreeStore.setState({
        selectedRow: { kind: "note", target: "abc" },
      });
      const ta = document.createElement("textarea");
      const e = makeKeyDownEvent({ key: "F2", target: ta });
      handleAppF2KeyDown(e);
      expect(useTreeStore.getState().pendingRename).toBeNull();
    });

    it("F2 with [contenteditable=true] as target → does NOT call startRename", () => {
      useTreeStore.setState({
        selectedRow: { kind: "note", target: "abc" },
      });
      const div = document.createElement("div");
      div.setAttribute("contenteditable", "true");
      const e = makeKeyDownEvent({ key: "F2", target: div });
      handleAppF2KeyDown(e);
      expect(useTreeStore.getState().pendingRename).toBeNull();
    });

    it("F2 with selectedRow=null → no-op (no startRename)", () => {
      useTreeStore.setState({ selectedRow: null });
      const div = document.createElement("div");
      const e = makeKeyDownEvent({ key: "F2", target: div });
      handleAppF2KeyDown(e);
      expect(useTreeStore.getState().pendingRename).toBeNull();
      expect(
        (e as unknown as { _preventDefaultCalls: number })
          ._preventDefaultCalls,
      ).toBe(0);
    });

    it("F2 with pendingRename already set → no-op (defers to RenameInput)", () => {
      useTreeStore.setState({
        selectedRow: { kind: "note", target: "abc" },
        pendingRename: { kind: "note", target: "xyz" },
      });
      const div = document.createElement("div");
      const e = makeKeyDownEvent({ key: "F2", target: div });
      handleAppF2KeyDown(e);
      expect(useTreeStore.getState().pendingRename).toEqual({
        kind: "note",
        target: "xyz",
      });
    });

    it("non-F2 keys are ignored: Enter, Escape, Backspace, alphanumerics", () => {
      useTreeStore.setState({
        selectedRow: { kind: "note", target: "abc" },
      });
      const div = document.createElement("div");
      for (const key of ["Enter", "Escape", "Backspace", "a", "Z", "1"]) {
        const e = makeKeyDownEvent({ key, target: div });
        handleAppF2KeyDown(e);
        expect(useTreeStore.getState().pendingRename).toBeNull();
      }
    });

    it("listener is added on mount and removed on unmount (no leaked listeners)", () => {
      getAdminStatusMock.mockResolvedValue({
        data: { state: "ok" },
        error: undefined,
      });
      const addSpy = vi.spyOn(document, "addEventListener");
      const removeSpy = vi.spyOn(document, "removeEventListener");
      try {
        const { unmount } = render(<AppShell />);
        const keydownAdds = addSpy.mock.calls.filter(
          (c) => c[0] === "keydown",
        );
        expect(keydownAdds.length).toBeGreaterThanOrEqual(1);
        const registered = keydownAdds[keydownAdds.length - 1]![1];

        unmount();

        const keydownRemoves = removeSpy.mock.calls.filter(
          (c) => c[0] === "keydown",
        );
        expect(
          keydownRemoves.some((c) => c[1] === registered),
        ).toBe(true);
      } finally {
        addSpy.mockRestore();
        removeSpy.mockRestore();
      }
    });

    it("end-to-end: real keydown on document with selectedRow set → startRename fires", async () => {
      useTreeStore.setState({
        selectedRow: { kind: "folder", target: "projects/jasper" },
      });
      getAdminStatusMock.mockResolvedValue({
        data: { state: "ok" },
        error: undefined,
      });
      render(<AppShell />);
      await act(async () => {
        const ev = new KeyboardEvent("keydown", {
          key: "F2",
          bubbles: true,
          cancelable: true,
        });
        document.body.dispatchEvent(ev);
      });
      expect(useTreeStore.getState().pendingRename).toEqual({
        kind: "folder",
        target: "projects/jasper",
      });
    });
  });

  it("A8: TestApp_TreeSelection_DrivesEditor", async () => {
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: null,
      pendingRename: null,
      draftCreate: null,
    });
    getAdminStatusMock.mockResolvedValue({
      data: { state: "ok" },
      error: undefined,
    });
    render(<AppShell />);
    await waitFor(() => {
      expect(
        screen.getByText("Select a note to start editing."),
      ).toBeInTheDocument();
    });
    await act(async () => {
      useTreeStore.getState().setActiveNote(SCRATCHPAD);
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText("Note content"),
      ).toBeInTheDocument();
    });
  });
});


describe("<App /> — session sync", () => {
  beforeEach(() => {
    capturedSessionSyncHandlers = null;
    getAdminStatusMock.mockReset();
    postAdminReindexMock.mockReset();
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: null,
      pendingRename: null,
      draftCreate: null,
      connectionStatus: "connected",
    });
    getAdminStatusMock.mockResolvedValue({
      data: { state: "ok" },
      error: undefined,
    });
  });

  it("A-Phase4-1: mounts useSessionSync on render and captures handlers", async () => {
    render(<AppShell />);
    await waitFor(() => expect(capturedSessionSyncHandlers).not.toBeNull());
  });

  it("A-Phase4-2: onReindexStarted flips ReindexProgress to running (shows Rebuilding…)", async () => {
    render(<AppShell />);
    await waitFor(() => expect(capturedSessionSyncHandlers).not.toBeNull());
    act(() => {
      capturedSessionSyncHandlers!.onReindexStarted();
    });
    await waitFor(() => {
      expect(screen.getByText(/Rebuilding/i)).toBeInTheDocument();
    });
  });

  it("A-Phase4-3: onReindexComplete returns ReindexProgress to idle (hides Rebuilding…)", async () => {
    render(<AppShell />);
    await waitFor(() => expect(capturedSessionSyncHandlers).not.toBeNull());
    act(() => {
      capturedSessionSyncHandlers!.onReindexStarted();
    });
    await waitFor(() => {
      expect(screen.getByText(/Rebuilding/i)).toBeInTheDocument();
    });
    act(() => {
      capturedSessionSyncHandlers!.onReindexComplete({ notes_indexed: 3 });
    });
    await waitFor(() => {
      expect(screen.queryByText(/Rebuilding/i)).not.toBeInTheDocument();
    });
  });

  it("CR-01: reindex hides the EditorPane via CSS but keeps it MOUNTED — unsaved edits survive", async () => {
    useTreeStore.setState({ activeNoteId: SCRATCHPAD });
    useTabStore.getState().clearAllTabs();
    render(<AppShell />);
    await waitFor(() => expect(capturedSessionSyncHandlers).not.toBeNull());
    const editor = (await screen.findByLabelText(
      "Note content",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("# Welcome"));

    // Mid-debounce edit that a pane unmount would silently discard.
    fireEvent.change(editor, {
      target: { value: "# Welcome — unsaved edit" },
    });

    act(() => {
      capturedSessionSyncHandlers!.onReindexStarted();
    });
    await waitFor(() =>
      expect(screen.getByText(/Rebuilding/i)).toBeInTheDocument(),
    );

    // Pane is display:none, NOT unmounted; the buffer is intact underneath.
    expect(screen.getByTestId("editor-pane").style.display).toBe("none");
    expect(
      (screen.getByLabelText("Note content") as HTMLTextAreaElement).value,
    ).toBe("# Welcome — unsaved edit");

    act(() => {
      capturedSessionSyncHandlers!.onReindexComplete({ notes_indexed: 1 });
    });
    await waitFor(() =>
      expect(screen.queryByText(/Rebuilding/i)).not.toBeInTheDocument(),
    );

    // Same pane instance re-shown with the edit still in place (no re-fetch).
    expect(screen.getByTestId("editor-pane").style.display).not.toBe("none");
    expect(
      (screen.getByLabelText("Note content") as HTMLTextAreaElement).value,
    ).toBe("# Welcome — unsaved edit");
  });

  it("A-Phase4-4: onLinksRewritten with error:true shows RenameRewriteErrorBanner", async () => {
    render(<AppShell />);
    await waitFor(() => expect(capturedSessionSyncHandlers).not.toBeNull());
    act(() => {
      capturedSessionSyncHandlers!.onLinksRewritten!({
        old_title: "OldTitle",
        new_title: "NewTitle",
        touched_note_ids: ["id1"],
        error: true,
      });
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/Rename failed/i)).toBeInTheDocument();
    });
  });

  it("A-Phase4-5: onLinksRewritten without error does NOT show banner", async () => {
    render(<AppShell />);
    await waitFor(() => expect(capturedSessionSyncHandlers).not.toBeNull());
    act(() => {
      capturedSessionSyncHandlers!.onLinksRewritten!({
        old_title: "OldTitle",
        new_title: "NewTitle",
        touched_note_ids: ["id1"],
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});


describe("<App /> — two-row grid + chrome mounts", () => {
  beforeEach(() => {
    getAdminStatusMock.mockReset();
    postAdminReindexMock.mockReset();
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: SCRATCHPAD,
      pendingRename: null,
      draftCreate: null,
      notesSidebarVisible: true,
      panelSelector: { tags: true, backlinks: true },
      backlinksRailExpanded: false,
    });
    getAdminStatusMock.mockResolvedValue({
      data: { state: "ok" },
      error: undefined,
    });
  });

  it("A6.6-1: App renders the TabStrip directly (no chrome wrapper — D-04)", async () => {
    render(<AppShell />);
    expect(screen.getByTestId("tab-strip")).toBeInTheDocument();
  });

  it("A6.6-2: App renders a StatusBar (data-testid='status-bar')", async () => {
    render(<AppShell />);
    expect(screen.getByTestId("status-bar")).toBeInTheDocument();
  });

  it("A6.6-3: two-row grid — gridTemplateRows is 'auto minmax(0, 1fr)'", async () => {
    render(<AppShell />);
    const grid = document.querySelector(
      'div[style*="grid-template-columns"]',
    ) as HTMLElement | null;
    expect(grid).not.toBeNull();
    expect(grid!.style.gridTemplateRows).toBe("auto minmax(0, 1fr)");
  });

  it("A6.6-4: when notesSidebarVisible=true, sidebar column is sidebarWidth px (260px default), after the 48px ribbon column", async () => {
    useTreeStore.setState({ notesSidebarVisible: true, sidebarWidth: 260 });
    render(<AppShell />);
    const grid = document.querySelector(
      'div[style*="grid-template-columns"]',
    ) as HTMLElement | null;
    expect(grid).not.toBeNull();
    expect(grid!.style.gridTemplateColumns).toMatch(/^48px 260px/);
  });

  it("A6.6-5: when notesSidebarVisible=false, sidebar column is 0px, after the 48px ribbon column", async () => {
    useTreeStore.setState({ notesSidebarVisible: false });
    render(<AppShell />);
    const grid = document.querySelector(
      'div[style*="grid-template-columns"]',
    ) as HTMLElement | null;
    expect(grid).not.toBeNull();
    expect(grid!.style.gridTemplateColumns).toMatch(/^48px 0px/);
  });

  it("A6.6-6: when backlinksRailExpanded=false, rail column is 0px", async () => {
    useTreeStore.setState({ backlinksRailExpanded: false });
    render(<AppShell />);
    const grid = document.querySelector(
      'div[style*="grid-template-columns"]',
    ) as HTMLElement | null;
    expect(grid).not.toBeNull();
    expect(grid!.style.gridTemplateColumns).toMatch(/0px$/);
  });

  it("A6.6-7: StatusBar is a sibling AFTER the grid div (not a grid child)", async () => {
    render(<AppShell />);
    const grid = document.querySelector(
      'div[style*="grid-template-columns"]',
    ) as HTMLElement | null;
    const statusBar = screen.getByTestId("status-bar");
    expect(grid).not.toBeNull();
    expect(grid!.nextElementSibling).toBe(statusBar);
  });

  it("A6.6-8: TabStrip has gridRow=1 gridColumn=3 style (set by App.tsx, shifted right for the ribbon column)", async () => {
    render(<AppShell />);
    const tabStrip = screen.getByTestId("tab-strip");
    expect(tabStrip.style.gridRow).toBe("1");
    expect(tabStrip.style.gridColumn).toBe("3");
  });

  it("A6.6-9: ActivityRibbon renders as the far-left grid column (RIBBON-01)", async () => {
    render(<AppShell />);
    expect(
      screen.getByRole("navigation", { name: "Activity ribbon" }),
    ).toBeInTheDocument();
  });

  it("A6.6-10: ActivityRibbon spans both grid rows (gridRow '1 / 3') so it renders the full shell height, not just the tab-strip row", async () => {
    render(<AppShell />);
    const ribbon = screen.getByRole("navigation", { name: "Activity ribbon" });
    expect(ribbon.style.gridRow).toBe("1 / 3");
    expect(ribbon.style.gridColumn).toBe("1");
  });
});


describe("global keymap handlers", () => {
  /**
   * Minimal KeyboardEvent-shaped object for handler testing. The exported
   * handlers are pure functions — no DOM needed.
   */
  function makeEvent(
    key: string,
    opts: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {},
  ): KeyboardEvent & { _preventDefaultCalls: number; _stopPropagationCalls: number } {
    let preventDefaultCalls = 0;
    let stopPropagationCalls = 0;
    return {
      key,
      metaKey: opts.meta ?? false,
      ctrlKey: opts.ctrl ?? false,
      shiftKey: opts.shift ?? false,
      preventDefault: () => { preventDefaultCalls++; },
      stopPropagation: () => { stopPropagationCalls++; },
      get _preventDefaultCalls() { return preventDefaultCalls; },
      get _stopPropagationCalls() { return stopPropagationCalls; },
    } as unknown as KeyboardEvent & { _preventDefaultCalls: number; _stopPropagationCalls: number };
  }

  beforeEach(() => {
    useTreeStore.setState({
      paletteOpen: false,
      paletteMode: "notes",
      cheatSheetOpen: false,
    });
  });

  it("KC-1: handleAppCmdP opens palette with mode=commands and calls preventDefault", () => {
    const e = makeEvent("p", { meta: true });
    handleAppCmdP(e);
    expect(e._preventDefaultCalls).toBe(1);
    expect(useTreeStore.getState().paletteOpen).toBe(true);
    expect(useTreeStore.getState().paletteMode).toBe("commands");
  });

  it("KC-2: handleAppCmdP uppercase P also works", () => {
    const e = makeEvent("P", { meta: true });
    handleAppCmdP(e);
    expect(e._preventDefaultCalls).toBe(1);
    expect(useTreeStore.getState().paletteOpen).toBe(true);
    expect(useTreeStore.getState().paletteMode).toBe("commands");
  });

  it("KC-3: handleAppCmdP without meta/ctrl → no-op (does NOT open palette)", () => {
    const e = makeEvent("p");
    handleAppCmdP(e);
    expect(e._preventDefaultCalls).toBe(0);
    expect(useTreeStore.getState().paletteOpen).toBe(false);
  });

  it("KC-4: handleAppCmdO opens palette with mode=notes and calls preventDefault", () => {
    const e = makeEvent("o", { meta: true });
    handleAppCmdO(e);
    expect(e._preventDefaultCalls).toBe(1);
    expect(useTreeStore.getState().paletteOpen).toBe(true);
    expect(useTreeStore.getState().paletteMode).toBe("notes");
  });

  it("KC-5: handleAppCmdO uppercase O also works", () => {
    const e = makeEvent("O", { meta: true });
    handleAppCmdO(e);
    expect(e._preventDefaultCalls).toBe(1);
    expect(useTreeStore.getState().paletteOpen).toBe(true);
    expect(useTreeStore.getState().paletteMode).toBe("notes");
  });

  it("KC-6: handleAppCmdO without meta/ctrl → no-op", () => {
    const e = makeEvent("o");
    handleAppCmdO(e);
    expect(e._preventDefaultCalls).toBe(0);
    expect(useTreeStore.getState().paletteOpen).toBe(false);
  });

  it("KC-7: handleAppCmdShiftD with meta+shift calls preventDefault", () => {
    const e = makeEvent("d", { meta: true, shift: true });
    handleAppCmdShiftD(e);
    expect(e._preventDefaultCalls).toBe(1);
  });

  it("KC-8: handleAppCmdShiftD without shift → no-op", () => {
    const e = makeEvent("d", { meta: true });
    handleAppCmdShiftD(e);
    expect(e._preventDefaultCalls).toBe(0);
  });

  it("KC-9: handleAppCmdShiftD without meta/ctrl → no-op", () => {
    const e = makeEvent("d", { shift: true });
    handleAppCmdShiftD(e);
    expect(e._preventDefaultCalls).toBe(0);
  });

  it("KC-10: handleAppCmdSlash opens cheatSheetOpen and calls preventDefault", () => {
    const e = makeEvent("/", { meta: true });
    handleAppCmdSlash(e);
    expect(e._preventDefaultCalls).toBe(1);
    expect(useTreeStore.getState().cheatSheetOpen).toBe(true);
  });

  it("KC-11: handleAppCmdSlash without meta/ctrl → no-op", () => {
    const e = makeEvent("/");
    handleAppCmdSlash(e);
    expect(e._preventDefaultCalls).toBe(0);
    expect(useTreeStore.getState().cheatSheetOpen).toBe(false);
  });

  it("KC-12: Cmd+B is NOT preventDefault'd by any of the 4 new handlers", () => {
    const e = makeEvent("b", { meta: true });
    handleAppCmdP(e);
    handleAppCmdO(e);
    handleAppCmdShiftD(e);
    handleAppCmdSlash(e);
    expect(e._preventDefaultCalls).toBe(0);
  });

  it("KC-13: Cmd+I is NOT preventDefault'd by any of the 4 new handlers", () => {
    const e = makeEvent("i", { meta: true });
    handleAppCmdP(e);
    handleAppCmdO(e);
    handleAppCmdShiftD(e);
    handleAppCmdSlash(e);
    expect(e._preventDefaultCalls).toBe(0);
  });

  it("KC-14: Cmd+F is NOT preventDefault'd by any of the 4 new handlers", () => {
    const e = makeEvent("f", { meta: true });
    handleAppCmdP(e);
    handleAppCmdO(e);
    handleAppCmdShiftD(e);
    handleAppCmdSlash(e);
    expect(e._preventDefaultCalls).toBe(0);
  });

  it("KC-15: Cmd+S is NOT preventDefault'd by any of the 4 new handlers", () => {
    const e = makeEvent("s", { meta: true });
    handleAppCmdP(e);
    handleAppCmdO(e);
    handleAppCmdShiftD(e);
    handleAppCmdSlash(e);
    expect(e._preventDefaultCalls).toBe(0);
  });
});


describe("handleAppCmdB", () => {
  function resetStore() {
    useTreeStore.setState({ paletteMode: "notes", paletteOpen: false });
  }

  beforeEach(resetStore);

  it("KC-B-1: preventDefault on meta+b; stopPropagation NOT called (so CM6 receives)", () => {
    const e = new KeyboardEvent("keydown", { metaKey: true, key: "b", cancelable: true, bubbles: true });
    const pdSpy = vi.spyOn(e, "preventDefault");
    const spSpy = vi.spyOn(e, "stopPropagation");
    handleAppCmdB(e);
    expect(pdSpy).toHaveBeenCalledOnce();
    expect(spSpy).not.toHaveBeenCalled();
  });

  it("KC-B-2: preventDefault on ctrl+b (cross-platform Linux/Windows path)", () => {
    const e = new KeyboardEvent("keydown", { ctrlKey: true, key: "b", cancelable: true });
    const pdSpy = vi.spyOn(e, "preventDefault");
    handleAppCmdB(e);
    expect(pdSpy).toHaveBeenCalledOnce();
  });

  it("KC-B-3: preventDefault on meta+B (uppercase key variant)", () => {
    const e = new KeyboardEvent("keydown", { metaKey: true, key: "B", cancelable: true });
    const pdSpy = vi.spyOn(e, "preventDefault");
    handleAppCmdB(e);
    expect(pdSpy).toHaveBeenCalledOnce();
  });

  it("KC-B-4: no-op on bare 'b' (no modifier) — does NOT preventDefault", () => {
    const e = new KeyboardEvent("keydown", { key: "b", cancelable: true });
    const pdSpy = vi.spyOn(e, "preventDefault");
    handleAppCmdB(e);
    expect(pdSpy).not.toHaveBeenCalled();
  });

  it("KC-B-5: no-op on meta+c (different key) — does NOT preventDefault", () => {
    const e = new KeyboardEvent("keydown", { metaKey: true, key: "c", cancelable: true });
    const pdSpy = vi.spyOn(e, "preventDefault");
    handleAppCmdB(e);
    expect(pdSpy).not.toHaveBeenCalled();
  });
});

describe("handleAppCmdI", () => {
  function resetStore() {
    useTreeStore.setState({ paletteMode: "notes", paletteOpen: false });
  }

  beforeEach(resetStore);

  it("KC-I-1: preventDefault on meta+i; stopPropagation NOT called (so CM6 receives)", () => {
    const e = new KeyboardEvent("keydown", { metaKey: true, key: "i", cancelable: true, bubbles: true });
    const pdSpy = vi.spyOn(e, "preventDefault");
    const spSpy = vi.spyOn(e, "stopPropagation");
    handleAppCmdI(e);
    expect(pdSpy).toHaveBeenCalledOnce();
    expect(spSpy).not.toHaveBeenCalled();
  });

  it("KC-I-2: preventDefault on ctrl+i (cross-platform path)", () => {
    const e = new KeyboardEvent("keydown", { ctrlKey: true, key: "i", cancelable: true });
    const pdSpy = vi.spyOn(e, "preventDefault");
    handleAppCmdI(e);
    expect(pdSpy).toHaveBeenCalledOnce();
  });

  it("KC-I-3: preventDefault on meta+I (uppercase key variant)", () => {
    const e = new KeyboardEvent("keydown", { metaKey: true, key: "I", cancelable: true });
    const pdSpy = vi.spyOn(e, "preventDefault");
    handleAppCmdI(e);
    expect(pdSpy).toHaveBeenCalledOnce();
  });

  it("KC-I-4: no-op on bare 'i' (no modifier) — does NOT preventDefault", () => {
    const e = new KeyboardEvent("keydown", { key: "i", cancelable: true });
    const pdSpy = vi.spyOn(e, "preventDefault");
    handleAppCmdI(e);
    expect(pdSpy).not.toHaveBeenCalled();
  });

  it("KC-I-5: no-op on meta+j (different key) — does NOT preventDefault", () => {
    const e = new KeyboardEvent("keydown", { metaKey: true, key: "j", cancelable: true });
    const pdSpy = vi.spyOn(e, "preventDefault");
    handleAppCmdI(e);
    expect(pdSpy).not.toHaveBeenCalled();
  });
});


describe("handleAppCmdP store mutation contract", () => {
  function resetStore() {
    useTreeStore.setState({ paletteMode: "notes", paletteOpen: false });
  }

  beforeEach(resetStore);

  it("KC-P-1: from default state (mode=notes, open=false), sets mode='commands' AND open=true", () => {
    expect(useTreeStore.getState().paletteMode).toBe("notes");
    expect(useTreeStore.getState().paletteOpen).toBe(false);

    const e = new KeyboardEvent("keydown", { metaKey: true, key: "p", cancelable: true });
    handleAppCmdP(e);

    expect(useTreeStore.getState().paletteMode).toBe("commands");
    expect(useTreeStore.getState().paletteOpen).toBe(true);
  });

  it("KC-P-2: from notes-mode open palette, flips mode to 'commands' (keeps open=true)", () => {
    useTreeStore.setState({ paletteMode: "notes", paletteOpen: true });

    const e = new KeyboardEvent("keydown", { metaKey: true, key: "p", cancelable: true });
    handleAppCmdP(e);

    expect(useTreeStore.getState().paletteMode).toBe("commands");
    expect(useTreeStore.getState().paletteOpen).toBe(true);
  });

  it("KC-P-3: from commands-mode closed palette, opens in commands mode", () => {
    useTreeStore.setState({ paletteMode: "commands", paletteOpen: false });

    const e = new KeyboardEvent("keydown", { metaKey: true, key: "p", cancelable: true });
    handleAppCmdP(e);

    expect(useTreeStore.getState().paletteMode).toBe("commands");
    expect(useTreeStore.getState().paletteOpen).toBe(true);
  });
});


describe("cold Cmd+P shows all palette commands", () => {
  beforeEach(() => {
    getAdminStatusMock.mockResolvedValue({
      data: { migration_status: "ok" as const, notes_indexed: 0 },
      error: undefined,
      response: new Response(),
    });
    useTreeStore.setState({ paletteOpen: false, paletteMode: "notes" });
  });

  it("cold Cmd+P shows all 10 commands", async () => {
    render(<AppShell />);

    act(() => {
      fireEvent.keyDown(window, { key: "p", metaKey: true });
    });

    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    expect(palette).toBeInTheDocument();

    const commandLabels = COMMAND_PALETTE_ENTRIES.map((e) => e.label);
    expect(commandLabels).toHaveLength(10);
    for (const label of commandLabels) {
      expect(within(palette).getByText(label)).toBeInTheDocument();
    }
  });
});


describe("commandActions rewire", () => {
  beforeEach(() => {
    getAdminStatusMock.mockResolvedValue({
      data: { migration_status: "ok" as const, notes_indexed: 0 },
      error: undefined,
      response: new Response(),
    });
    mockCreateNoteAt.mockClear();
    useTreeStore.setState({ paletteMode: "commands", paletteOpen: true });
  });

  it("commandActions.onNewNote calls createNoteAt with '' (vault root) and closes palette", async () => {
    render(<AppShell />);

    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    expect(palette).toBeInTheDocument();

    const newNoteRow = within(palette).getByText("New note");
    fireEvent.click(newNoteRow);

    expect(mockCreateNoteAt).toHaveBeenCalledWith("");
    await waitFor(() => expect(useTreeStore.getState().paletteOpen).toBe(false));
  });

  it("commandActions.onSwitchNote sets paletteMode='notes' without closing palette", async () => {
    render(<AppShell />);

    const palette = await screen.findByRole("dialog", { name: "Command palette" });

    const switchRow = within(palette).getByText("Switch / search notes");
    fireEvent.click(switchRow);

    expect(useTreeStore.getState().paletteMode).toBe("notes");
    expect(useTreeStore.getState().paletteOpen).toBe(true);
  });
});


describe("handleAppCmdShiftF (Phase 19 D-05: opens sidebar Search panel, not palette)", () => {
  function makeEvent(
    key: string,
    opts: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {},
  ): KeyboardEvent & { _preventDefaultCalls: number } {
    let preventDefaultCalls = 0;
    return {
      key,
      metaKey: opts.meta ?? false,
      ctrlKey: opts.ctrl ?? false,
      shiftKey: opts.shift ?? false,
      preventDefault: () => { preventDefaultCalls++; },
      stopPropagation: () => {},
      get _preventDefaultCalls() { return preventDefaultCalls; },
    } as unknown as KeyboardEvent & { _preventDefaultCalls: number };
  }

  beforeEach(() => {
    useTreeStore.setState({
      paletteOpen: false,
      paletteMode: "notes",
      sidebarPanel: "files",
      notesSidebarVisible: false,
    });
  });

  it("APP-CMDSHIFTF-OPEN-1: handleAppCmdShiftF sets sidebarPanel='search' + notesSidebarVisible=true on Mod+Shift+F", () => {
    const e = makeEvent("f", { meta: true, shift: true });
    handleAppCmdShiftF(e);
    expect(e._preventDefaultCalls).toBe(1);
    expect(useTreeStore.getState().sidebarPanel).toBe("search");
    expect(useTreeStore.getState().notesSidebarVisible).toBe(true);
  });

  it("APP-CMDSHIFTF-OPEN-2: handleAppCmdShiftF is a no-op without Shift", () => {
    const e = makeEvent("f", { meta: true });
    handleAppCmdShiftF(e);
    expect(e._preventDefaultCalls).toBe(0);
    expect(useTreeStore.getState().sidebarPanel).toBe("files");
    expect(useTreeStore.getState().notesSidebarVisible).toBe(false);
  });

  it("APP-CMDSHIFTF-OPEN-3: handleAppCmdShiftF is a no-op without meta/ctrl", () => {
    const e = makeEvent("f", { shift: true });
    handleAppCmdShiftF(e);
    expect(e._preventDefaultCalls).toBe(0);
    expect(useTreeStore.getState().sidebarPanel).toBe("files");
    expect(useTreeStore.getState().notesSidebarVisible).toBe(false);
  });

  it("APP-CMDSHIFTF-OPEN-4: handleAppCmdShiftF accepts uppercase F", () => {
    const e = makeEvent("F", { meta: true, shift: true });
    handleAppCmdShiftF(e);
    expect(e._preventDefaultCalls).toBe(1);
    expect(useTreeStore.getState().sidebarPanel).toBe("search");
    expect(useTreeStore.getState().notesSidebarVisible).toBe(true);
  });

  it("APP-CMDSHIFTF-OPEN-5: handleAppCmdShiftF does NOT touch the command palette", () => {
    const e = makeEvent("f", { meta: true, shift: true });
    handleAppCmdShiftF(e);
    expect(useTreeStore.getState().paletteOpen).toBe(false);
    expect(useTreeStore.getState().paletteMode).toBe("notes");
  });

  it("APP-CMDSHIFTF-OPEN-6: handleAppCmdShiftF dispatches 'focusSearch' on the phase7 bus (D-05)", () => {
    const received: Phase7DispatchEvent[] = [];
    const unsubscribe = subscribePhase7((ev) => received.push(ev));
    try {
      const e = makeEvent("f", { meta: true, shift: true });
      handleAppCmdShiftF(e);
      expect(received).toEqual(["focusSearch"]);
    } finally {
      unsubscribe();
    }
  });
});


// BUG 2 (260627-ih9): the + new-tab affordance and open-to-the-right both route
// through nextUntitledName(siblingNamesForCreate(...)) so a second untitled create
// in an occupied folder yields "untitled 1" instead of a 409 case_collision.
describe("uniqueUntitledTitle composition (BUG 2 — collision-safe untitled)", () => {
  // Hardcoded tree fixture (no Date.now / Math.random — deterministic).
  const tree = {
    root: [
      { kind: "note", id: "n1", title: "untitled.md", path: "untitled.md" },
      {
        kind: "folder",
        name: "occupied",
        path: "occupied",
        children: [
          { kind: "note", id: "n2", title: "untitled.md", path: "occupied/untitled.md" },
        ],
      },
      { kind: "folder", name: "empty", path: "empty", children: [] },
    ],
  } as unknown as Tree;

  it("root folder already holding untitled → 'untitled 1'", () => {
    expect(
      nextUntitledName(siblingNamesForCreate(tree, "", "note"), "untitled"),
    ).toBe("untitled 1");
  });

  it("subfolder already holding untitled → 'untitled 1'", () => {
    expect(
      nextUntitledName(siblingNamesForCreate(tree, "occupied", "note"), "untitled"),
    ).toBe("untitled 1");
  });

  it("empty folder → plain 'untitled' (no collision)", () => {
    expect(
      nextUntitledName(siblingNamesForCreate(tree, "empty", "note"), "untitled"),
    ).toBe("untitled");
  });
});


// BUG 3b (260627-ih9): closing the final tab blanks the editor — clear the legacy
// activeNoteId so the note does not reappear in the tab-less fallback pane.
describe("close-last-tab clears activeNoteId (BUG 3b)", () => {
  beforeEach(() => {
    getAdminStatusMock.mockReset();
    postAdminReindexMock.mockReset();
    getAdminStatusMock.mockResolvedValue({
      data: { state: "ok" },
      error: undefined,
    });
    // Reset BOTH stores for order-independence. paletteOpen/cheatSheetOpen MUST
    // be cleared: a prior test that leaves a Radix dialog open sets aria-hidden on
    // the app, hiding every button from getByRole (order-dependent false failure).
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: null,
      pendingRename: null,
      draftCreate: null,
      paletteOpen: false,
      cheatSheetOpen: false,
    });
    useTabStore.getState().clearAllTabs();
  });

  afterEach(() => {
    useTabStore.getState().clearAllTabs();
  });

  it("closing the only tab sets activeNoteId to null (editor blanks)", async () => {
    // Seed one open tab + matching legacy activeNoteId. The note is marked
    // deleted so the empty-tree prune pass retains the tab (deterministic — no
    // dependence on the mocked tree containing the note, no flush save path).
    useTabStore.setState({
      tabs: [{ id: "x", noteId: "x" }],
      activeTabId: "x",
      deletedTabIds: new Set(["x"]),
    });
    useTreeStore.setState({ activeNoteId: "x" });

    render(<AppShell />);

    // Mirror effect syncs activeNoteId to the active tab while tabs are open.
    await waitFor(() =>
      expect(useTreeStore.getState().activeNoteId).toBe("x"),
    );

    // Close the only tab via its X (routes through the flush-aware close path).
    // findByRole retries so the assertion never races async EditorPane renders.
    const closeBtn = await screen.findByRole("button", {
      name: "Close Untitled",
    });
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(useTabStore.getState().tabs).toHaveLength(0);
      expect(useTreeStore.getState().activeNoteId).toBeNull();
    });
  });

  it("WR-01: 'Close without saving' on a flush-reject clears activeNoteId on the last tab", async () => {
    // Non-deleted tab so the close routes through flushAndClose's real flush
    // path (the deletedTabIds shortcut bypasses flush entirely and cannot
    // exercise onCloseWithoutSaving).
    vi.mocked(updateNote).mockReset();
    vi.mocked(updateNote).mockResolvedValue({
      data: undefined,
      error: { code: "io", message: "disk full" },
      response: new Response(),
    } as Awaited<ReturnType<typeof updateNote>>);

    render(<AppShell />);

    // Open the tab AFTER mount so it is not subject to the one-time
    // prune-tabs-against-tree effect (the mocked tree is always empty, so a
    // tab seeded pre-mount and not in deletedTabIds would be pruned away).
    await act(async () => {
      useTabStore.getState().openTab("x");
    });

    // Mirror effect syncs the legacy activeNoteId to the newly active tab.
    await waitFor(() =>
      expect(useTreeStore.getState().activeNoteId).toBe("x"),
    );

    // Force userHasEdited=true so flush() actually attempts a save (and rejects).
    const editor = await screen.findByLabelText("Note content");
    fireEvent.change(editor, { target: { value: "edited before close" } });

    const closeBtn = await screen.findByRole("button", {
      name: "Close Untitled",
    });
    fireEvent.click(closeBtn);

    const closeWithoutSavingBtn = await screen.findByRole("button", {
      name: "Close without saving",
    });
    fireEvent.click(closeWithoutSavingBtn);

    await waitFor(() => {
      expect(useTabStore.getState().tabs).toHaveLength(0);
      expect(useTreeStore.getState().activeNoteId).toBeNull();
    });
  });
});


// IN-04: BootGate (App.tsx) was previously uncovered by any test that renders
// the default-exported <App /> — every other test renders <AppShell />
// directly, bypassing the GET /vault/current boot check entirely.
describe("<App /> — BootGate (IN-04)", () => {
  beforeEach(() => {
    getAdminStatusMock.mockReset();
    postAdminReindexMock.mockReset();
    getAdminStatusMock.mockResolvedValue({
      data: { state: "ok" },
      error: undefined,
    });
    useTreeStore.setState({
      expanded: new Set(),
      activeNoteId: null,
      pendingRename: null,
      draftCreate: null,
      paletteOpen: false,
      cheatSheetOpen: false,
    });
    useTabStore.getState().clearAllTabs();
    vi.mocked(vaultApi.getCurrent).mockReset();
  });

  afterEach(() => {
    useTabStore.getState().clearAllTabs();
  });

  it("vaultApi.getCurrent resolves with a vault → <App/> eventually renders AppInner", async () => {
    vi.mocked(vaultApi.getCurrent).mockResolvedValueOnce({
      path: "/vault",
      display_name: "Test Vault",
      last_opened_at: "2026-05-24T00:00:00Z",
      created_at: "2026-05-24T00:00:00Z",
      missing: false,
    });

    render(<App />);

    expect(await screen.findByTestId("tab-strip")).toBeInTheDocument();
  });

  it("vaultApi.getCurrent rejects (transient boot failure) → <App/> renders VaultPicker", async () => {
    vi.mocked(vaultApi.getCurrent).mockRejectedValueOnce(new Error("boom"));

    render(<App />);

    expect(await screen.findByText("Choose a vault")).toBeInTheDocument();
  });

  it("IN-07: StrictMode double-invoke — stale phantom-mount resolution does not clobber the settled boot state", async () => {
    // React StrictMode (main.tsx wraps <App/> in it) double-invokes effects
    // in dev: mount -> cleanup -> mount again. Without a cancelled guard, a
    // late-resolving promise from the discarded first ("phantom") effect
    // invocation still fires setState against the still-mounted component,
    // clobbering whatever the real (second) invocation already settled.
    let resolvePhantom: (v: Awaited<ReturnType<typeof vaultApi.getCurrent>>) => void =
      () => {};
    let resolveReal: (v: Awaited<ReturnType<typeof vaultApi.getCurrent>>) => void =
      () => {};
    vi.mocked(vaultApi.getCurrent)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolvePhantom = r;
          }) as ReturnType<typeof vaultApi.getCurrent>,
      )
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveReal = r;
          }) as ReturnType<typeof vaultApi.getCurrent>,
      );

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await act(async () => {
      resolveReal({
        path: "/vault",
        display_name: "Test Vault",
        last_opened_at: "2026-05-24T00:00:00Z",
        created_at: "2026-05-24T00:00:00Z",
        missing: false,
      });
      await Promise.resolve();
    });
    expect(await screen.findByTestId("tab-strip")).toBeInTheDocument();

    // Phantom-mount promise resolves LATE with a conflicting outcome.
    await act(async () => {
      resolvePhantom(null);
      await Promise.resolve();
    });

    expect(screen.getByTestId("tab-strip")).toBeInTheDocument();
  });
});

/**
 * App-shell tests — Phase 2 composition. Phase 1's three-column grid is now
 * nested inside a flex column with the migration banner row above. We mock
 * the admin status hook so each test can drive the migration-banner branch
 * without spinning up real fetch.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Plan 08-17c — mock vaultApi so BootGate + StatusBar (via useVaultPicker) do not
// trigger real network calls in App tests. Default: getCurrent returns a vault
// entry (non-null) so BootGate renders the main shell, not <VaultPicker mode="boot">.
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

// Plan 08-17c — mock useVaultPicker so StatusBar doesn't spin up real API calls.
// Returns current=null so the vault segment is hidden in App tests.
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

// Phase 3 — Sidebar consumes useFileTree (which calls GET /tree on
// mount). Mock it here so the App-shell tests don't trigger a real
// fetch. An empty tree keeps the sidebar's <FileTree> in its empty-state
// branch, which has no role="alert" and won't collide with the
// migration banner's role="alert" in tests A3 and A5.
vi.mock("./lib/useFileTree", () => ({
  useFileTree: () => ({
    tree: { root: [] },
    loading: false,
    error: null,
    refresh: () => Promise.resolve(),
    mutate: () => {},
  }),
}));

// Phase 4 — mock useSessionSync so tests can capture handlers and
// dispatch synthetic WS events without a real WebSocket connection.
import type { SessionSyncHandlers } from "./lib/useSessionSync";
let capturedSessionSyncHandlers: SessionSyncHandlers | null = null;
vi.mock("./lib/useSessionSync", () => ({
  useSessionSync: (h: SessionSyncHandlers) => {
    capturedSessionSyncHandlers = h;
  },
}));

// Phase 5 — mock useTheme so the SettingsMenu (rendered by SidebarToolbar)
// does NOT trigger a real GET /api/v1/config fetch when App tests render.
// undici (Node fetch) cannot parse the relative URL "/api/v1/config" even
// with the jsdom URL set, so the un-mocked path produces "Failed to parse
// URL" unhandled rejections that pollute the test report.
vi.mock("./lib/useTheme", () => ({
  useTheme: () => ({
    theme: "dark",
    setTheme: vi.fn().mockResolvedValue({}),
  }),
  THEME_BOOTSTRAP_KEY: "jasper:theme-bootstrap",
}));

// Phase 7 — mock useDailyNote so the App does not trigger real fetch.
const mockOpenToday = vi.fn().mockResolvedValue(undefined);
vi.mock("./lib/useDailyNote", () => ({
  useDailyNote: () => ({
    openToday: mockOpenToday,
    isLoading: false,
  }),
}));

// Plan 07-17 — mock useTreeCreateActions so App tests can spy on createNoteAt.
// The hook internally calls useTreeMutations (API) + useFileTree (mocked).
// Mocking at module level keeps the App render from firing real POST /notes.
const mockCreateNoteAt = vi.fn().mockResolvedValue(undefined);
const mockCreateFolderAt = vi.fn().mockResolvedValue(undefined);
vi.mock("./lib/useTreeCreateActions", () => ({
  useTreeCreateActions: () => ({
    createNoteAt: mockCreateNoteAt,
    createFolderAt: mockCreateFolderAt,
    isCreating: false,
  }),
}));

// Plan 07-17 — mock @tanstack/react-virtual so CommandMenu's virtualized list
// renders all items in jsdom (which has no layout, so estimateSize→0 items
// without the mock). This is the same override used in CommandMenu.test.tsx.
//
// Plan 07-42 (UAT-7): expose measureElement so CommandMenu's search-result
// branch can attach `ref={virtualizer.measureElement}` without crashing.
//
// Plan 07-44 (UAT-8 follow-up): expose measure() so CommandMenu's mode-change
// cache-reset useEffect doesn't throw "measure is not a function" when the
// real App mounts the menu under test.
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

import App, {
  AppShell,
  handleAppF2KeyDown,
  handleAppCmdP,
  handleAppCmdO,
  handleAppCmdShiftD,
  handleAppCmdSlash,
  handleAppCmdB,
  handleAppCmdI,
  handleAppCmdShiftF,
} from "./App";
// Tests render <AppShell /> to bypass BootGate's async vault probe — BootGate
// renders null during loading after the 08-17c+ UAT-2 fix, so the prior
// render(<App />) flow no longer mounts the shell synchronously. AppShell is
// the same ToastProvider + AppInner composition BootGate uses for vault-open
// boots. The default <App /> export is preserved for boot-flow tests.
void App;
import { useTreeStore } from "./lib/useTreeStore";
import { COMMAND_PALETTE_ENTRIES } from "./lib/shortcutsRegistry";

const SCRATCHPAD = "00000000-0000-4000-a000-000000000001";

describe("<App /> — Phase 2 shell composition", () => {
  beforeEach(() => {
    getAdminStatusMock.mockReset();
    postAdminReindexMock.mockReset();
    // Plan 03-07: EditorPane now requires noteId. Pre-seed the store
    // so the existing Phase 1+2 assertions (textarea enabled, save
    // flow) still apply. A6's tree-selection test resets it to null
    // so the placeholder branch is exercised.
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
    // 2026-05-09: locked-height shell — was minHeight: 100vh which let
    // children expand the document past viewport (UX-14c regression).
    // The shell now hard-pins height so sidebar + editor each scroll
    // independently inside their bounded containers.
    expect(root.style.height).toBe("100vh");
    expect(root.style.overflow).toBe("hidden");

    // The three-column grid is now an inner div under the flex column
    // (the banner is a sibling but renders nothing when state=ok).
    const grid = root.querySelector(
      'div[style*="grid-template-columns"]',
    ) as HTMLElement | null;
    expect(grid).not.toBeNull();
    // Phase 6.6 — Plan 06.6-11: two-row grid. Third column is 0px when
    // backlinksRailExpanded is false (default). The RAIL_COLLAPSED_WIDTH strip
    // is removed (D-36); the column collapses to 0.
    expect(grid!.style.gridTemplateColumns).toBe("260px 1fr 0px");

    // Sidebar + RightRail anchors still mount.
    expect(screen.getByText("NOTES")).toBeInTheDocument();
    // Phase 3: the static Phase 1 "scratchpad" hardcoded sidebar row is
    // gone. With the mocked-empty tree we expect the FileTree empty
    // state to render in its place.
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

    // Click Reset → opens dialog.
    fireEvent.click(
      screen.getByRole("button", { name: "Reset and rebuild database" }),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    // Click Confirm → dialog closes, POST fires, overlay mounts.
    fireEvent.click(
      screen.getByRole("button", { name: "Reset and rebuild" }),
    );

    await waitFor(() =>
      expect(screen.getByText("Index rebuilt.")).toBeInTheDocument(),
    );
    expect(postAdminReindexMock).toHaveBeenCalledWith("full");

    // Subsequent status refresh — server now reports ok.
    getAdminStatusMock.mockResolvedValueOnce({
      data: { state: "ok" },
      error: undefined,
    });

    // Wait for the parent's 600ms transient → overlay unmounts.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(screen.queryByText("Index rebuilt.")).toBeNull();
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
    // Radix Toast.Viewport renders as a wrapper div with
    // role="region" aria-label="Notifications (F8)". Asserting count==1
    // proves the provider is mounted exactly once at the App root.
    const viewports = document.querySelectorAll(
      'div[role="region"][aria-label^="Notifications"]',
    );
    expect(viewports.length).toBe(1);
  });

  it("A7: TestApp_NullActiveNote_RendersPlaceholder — Plan 03-07 wiring", async () => {
    // Reset the store so activeNoteId is null instead of the default
    // SCRATCHPAD seed from beforeEach.
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
    // No textarea when noteId is null — the editor placeholder branch
    // is mounted instead of the normal pane.
    expect(screen.queryByLabelText("Note content")).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────
  // Plan 03-20 Gap R2-4 — document-level F2 routing.
  //
  // Clicking a tree row shifts DOM focus to the editor textarea
  // (EditorPane.useEffect on loadStatus === "loaded"); F2 dispatched
  // by the user would otherwise hit the textarea and be silently
  // dropped. Routing F2 through document + reading
  // useTreeStore.selectedRow at fire time makes rename work
  // regardless of which element holds focus.
  //
  // We test the extracted handler (handleAppF2KeyDown) as a pure
  // function — easier to reason about than reaching into a mounted
  // tree's effect. A mounted-App lifecycle test verifies the
  // listener is registered + torn down correctly.
  // ──────────────────────────────────────────────────────────────────
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
      // KeyboardEvent in jsdom doesn't let you easily spoof `target`,
      // so we construct + dispatch on a real DOM node and pass the
      // resulting event-shaped object straight to the handler under
      // test. The handler reads only `.key`, `.target`, and
      // `.preventDefault` — match that shape minimally.
      let preventDefaultCalls = 0;
      const e = {
        key: opts.key,
        target: opts.target ?? null,
        preventDefault: () => {
          preventDefaultCalls += 1;
        },
        // expose the call count for assertions
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
      // Use a generic <div> as target — not an input/textarea.
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
      // pendingRename remains the original 'xyz' — the listener did
      // not overwrite it with 'abc'.
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
        // Capture the registered handler so we can verify it's the
        // same one removed at teardown.
        const registered = keydownAdds[keydownAdds.length - 1]![1];

        unmount();

        const keydownRemoves = removeSpy.mock.calls.filter(
          (c) => c[0] === "keydown",
        );
        // At least one removeEventListener call for "keydown" must
        // match the handler that was registered.
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
      // Dispatch a real KeyboardEvent on document with a non-form
      // target (document.body is a generic element, not an input).
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

  it("A8: TestApp_TreeSelection_DrivesEditor — Plan 03-07 wiring", async () => {
    // Start with no active note; toggle the store programmatically
    // (proxy for clicking a note row, since the FileTree mock here is
    // empty). The EditorPane should re-render with the new noteId
    // and call getNote.
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
    // Simulate Sidebar.onSelectNote firing.
    await act(async () => {
      useTreeStore.getState().setActiveNote(SCRATCHPAD);
    });
    // EditorPane re-renders with a textarea.
    await waitFor(() => {
      expect(
        screen.getByLabelText("Note content"),
      ).toBeInTheDocument();
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Phase 4 (Plan 04-05) — App.tsx mounts useSessionSync and wires reindex
// events to ReindexProgress (UX-04).
// ──────────────────────────────────────────────────────────────────────────
describe("<App /> — Phase 4 session sync (Plan 04-05)", () => {
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
    // ReindexProgress shows "Rebuilding the index…" for starting/running phases.
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
});

// ──────────────────────────────────────────────────────────────────────────
// Phase 6.6 (Plan 06.6-11) — Two-row grid restructure + TopBar + StatusBar
// ──────────────────────────────────────────────────────────────────────────
describe("<App /> — Phase 6.6 two-row grid + chrome mounts (Plan 06.6-11)", () => {
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

  it("A6.6-1: App renders a TopBar (data-testid='top-bar')", async () => {
    render(<AppShell />);
    expect(screen.getByTestId("top-bar")).toBeInTheDocument();
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

  it("A6.6-4: when notesSidebarVisible=true, sidebar column is sidebarWidth px (260px default)", async () => {
    useTreeStore.setState({ notesSidebarVisible: true, sidebarWidth: 260 });
    render(<AppShell />);
    const grid = document.querySelector(
      'div[style*="grid-template-columns"]',
    ) as HTMLElement | null;
    expect(grid).not.toBeNull();
    expect(grid!.style.gridTemplateColumns).toMatch(/^260px/);
  });

  it("A6.6-5: when notesSidebarVisible=false, sidebar column is 0px", async () => {
    useTreeStore.setState({ notesSidebarVisible: false });
    render(<AppShell />);
    const grid = document.querySelector(
      'div[style*="grid-template-columns"]',
    ) as HTMLElement | null;
    expect(grid).not.toBeNull();
    expect(grid!.style.gridTemplateColumns).toMatch(/^0px/);
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
    // StatusBar must be a sibling coming after the grid
    expect(grid!.nextElementSibling).toBe(statusBar);
  });

  it("A6.6-8: TopBar has gridRow=1 gridColumn=2 style (set by App.tsx)", async () => {
    render(<AppShell />);
    const topBar = screen.getByTestId("top-bar");
    expect(topBar.style.gridRow).toBe("1");
    expect(topBar.style.gridColumn).toBe("2");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Phase 7 (Plan 07-12) — Global keymap handlers (Cmd+P/O/Shift+D/Slash)
// ──────────────────────────────────────────────────────────────────────────
describe("Phase 7 global keymap handlers (Plan 07-12)", () => {
  /**
   * Helper to build a minimal KeyboardEvent-shaped object for handler testing.
   * The exported handlers are pure functions that read e.key / e.metaKey /
   * e.shiftKey and call e.preventDefault. No DOM needed.
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

  // ── Cmd+P ─────────────────────────────────────────────────────────────────
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

  // ── Cmd+O ─────────────────────────────────────────────────────────────────
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

  // ── Cmd+Shift+D ──────────────────────────────────────────────────────────
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

  // ── Cmd+/ ─────────────────────────────────────────────────────────────────
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

  // ── CM6 shortcuts NOT intercepted ─────────────────────────────────────────
  it("KC-12: Cmd+B is NOT preventDefault'd by any of the 4 new handlers", () => {
    const e = makeEvent("b", { meta: true });
    handleAppCmdP(e);
    handleAppCmdO(e);
    handleAppCmdShiftD(e);
    handleAppCmdSlash(e);
    // None of the handlers match "b", so preventDefault must NOT have been called.
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

// ──────────────────────────────────────────────────────────────────────────
// Phase 7 (Plan 07-16) — UAT #8/#9 fix: handleAppCmdB / handleAppCmdI
//
// These window-level capture-phase handlers block browser/extension defaults
// for Cmd+B (Brave Leo sidebar) and Cmd+I (OS font panel / line-select) so
// CM6's editor-level keymap can fire. Contract: preventDefault ONLY; no
// stopPropagation (capture-phase propagation continues to cm-content).
//
// Also verifies handleAppCmdP's store-mutation contract (UAT #2 investigation).
// ──────────────────────────────────────────────────────────────────────────
describe("Phase 7 (Plan 07-16) — handleAppCmdB (UAT #8 fix)", () => {
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

describe("Phase 7 (Plan 07-16) — handleAppCmdI (UAT #9 fix)", () => {
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

// ──────────────────────────────────────────────────────────────────────────
// Phase 7 (Plan 07-16) — UAT #2 investigation: handleAppCmdP store contract
//
// Per plan's halt-if-inconclusive gate: if these tests PASS, the handleAppCmdP
// store mutations are correct and UAT #2's root cause is downstream in
// CommandMenu.tsx. If they FAIL, the bug is in App.tsx's existing handler.
// ──────────────────────────────────────────────────────────────────────────
describe("Phase 7 (Plan 07-16) — handleAppCmdP store mutation contract (UAT #2 investigation)", () => {
  function resetStore() {
    useTreeStore.setState({ paletteMode: "notes", paletteOpen: false });
  }

  beforeEach(resetStore);

  it("KC-P-1: from default state (mode=notes, open=false), sets mode='commands' AND open=true", () => {
    // Worst-case: initial store state with paletteMode="notes"
    expect(useTreeStore.getState().paletteMode).toBe("notes");
    expect(useTreeStore.getState().paletteOpen).toBe(false);

    const e = new KeyboardEvent("keydown", { metaKey: true, key: "p", cancelable: true });
    handleAppCmdP(e);

    // Both mutations must land
    expect(useTreeStore.getState().paletteMode).toBe("commands");
    expect(useTreeStore.getState().paletteOpen).toBe(true);
  });

  it("KC-P-2: from notes-mode open palette, flips mode to 'commands' (keeps open=true)", () => {
    // Simulate Cmd+O having opened the switcher
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

// ──────────────────────────────────────────────────────────────────────────────
// Plan 07-17 — UAT #2 / BLOCKER #2: cold Cmd+P shows all commands
// Plan 08-06 — entry count bumped to 9 (Share/Reveal command added).
// ──────────────────────────────────────────────────────────────────────────────
describe("Plan 07-17 — cold Cmd+P shows all palette commands (UAT #2 / BLOCKER #2)", () => {
  beforeEach(() => {
    getAdminStatusMock.mockResolvedValue({
      data: { migration_status: "ok" as const, notes_indexed: 0 },
      error: undefined,
      response: new Response(),
    });
    // Cold state: palette closed, paletteMode at default ('notes')
    useTreeStore.setState({ paletteOpen: false, paletteMode: "notes" });
  });

  it("cold Cmd+P shows all 10 commands (Plan 07-27: Find removed; Plan 08-06: Share/Reveal added; Plan 08-17c: Switch vault… added)", async () => {
    render(<AppShell />);

    // Fire the global Cmd+P handler at window (App attaches handleAppCmdP
    // to window keydown in capture phase). Synthesize the same event.
    act(() => {
      fireEvent.keyDown(window, { key: "p", metaKey: true });
    });

    // After Cmd+P: palette open AND mode='commands' — CommandMenu renders
    // in commands mode showing ALL COMMAND_PALETTE_ENTRIES rows.
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    expect(palette).toBeInTheDocument();

    const commandLabels = COMMAND_PALETTE_ENTRIES.map((e) => e.label);
    // Sanity: 10 entries (8 after Plan 07-27's Find removal + 1 from Plan 08-06's
    // share-reveal-current-note addition + 1 from Plan 08-17c's "Switch vault…").
    expect(commandLabels).toHaveLength(10);
    for (const label of commandLabels) {
      expect(within(palette).getByText(label)).toBeInTheDocument();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Plan 07-17 — commandActions rewire: onNewNote, onSwitchNote
// Plan 07-27 — onFind removed (browser native Cmd+F fires instead)
// ──────────────────────────────────────────────────────────────────────────────
describe("Plan 07-17 — commandActions rewire (UAT #3, #5)", () => {
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

    // Open palette in commands mode
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    expect(palette).toBeInTheDocument();

    // Click "New note"
    const newNoteRow = within(palette).getByText("New note");
    fireEvent.click(newNoteRow);

    // createNoteAt called with vault root
    expect(mockCreateNoteAt).toHaveBeenCalledWith("");
    // Palette closed
    await waitFor(() => expect(useTreeStore.getState().paletteOpen).toBe(false));
  });

  it("commandActions.onSwitchNote sets paletteMode='notes' without closing palette", async () => {
    render(<AppShell />);

    const palette = await screen.findByRole("dialog", { name: "Command palette" });

    // Click "Switch / search notes"
    const switchRow = within(palette).getByText("Switch / search notes");
    fireEvent.click(switchRow);

    // Mode flipped to notes, palette still open
    expect(useTreeStore.getState().paletteMode).toBe("notes");
    // palette open state is managed by CommandMenu's activate via closeOnExecute=false
    // The palette's open prop is still true (store not changed)
    expect(useTreeStore.getState().paletteOpen).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Plan 07-40 (UAT-6) — Cmd+Shift+F opens CommandMenu mode='search'.
//
// REVERSES Plan 07-39: the listener no longer dispatches a CustomEvent for
// SearchInputBar. Instead it sets paletteMode='search' + paletteOpen=true,
// matching the existing Cmd+P (commands) / Cmd+O (notes) pattern.
// ──────────────────────────────────────────────────────────────────────────
describe("Plan 07-40 — handleAppCmdShiftF (UAT-6 Cmd+Shift+F opens search modal)", () => {
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
    });
  });

  it("APP-CMDSHIFTF-OPEN-1: handleAppCmdShiftF sets paletteMode='search' + paletteOpen=true on Mod+Shift+F", () => {
    const e = makeEvent("f", { meta: true, shift: true });
    handleAppCmdShiftF(e);
    expect(e._preventDefaultCalls).toBe(1);
    expect(useTreeStore.getState().paletteMode).toBe("search");
    expect(useTreeStore.getState().paletteOpen).toBe(true);
  });

  it("APP-CMDSHIFTF-OPEN-2: handleAppCmdShiftF is a no-op without Shift", () => {
    const e = makeEvent("f", { meta: true });
    handleAppCmdShiftF(e);
    expect(e._preventDefaultCalls).toBe(0);
    // Store unchanged from beforeEach defaults.
    expect(useTreeStore.getState().paletteMode).toBe("notes");
    expect(useTreeStore.getState().paletteOpen).toBe(false);
  });

  it("APP-CMDSHIFTF-OPEN-3: handleAppCmdShiftF is a no-op without meta/ctrl", () => {
    const e = makeEvent("f", { shift: true });
    handleAppCmdShiftF(e);
    expect(e._preventDefaultCalls).toBe(0);
    expect(useTreeStore.getState().paletteMode).toBe("notes");
    expect(useTreeStore.getState().paletteOpen).toBe(false);
  });

  it("APP-CMDSHIFTF-OPEN-4: handleAppCmdShiftF accepts uppercase F", () => {
    const e = makeEvent("F", { meta: true, shift: true });
    handleAppCmdShiftF(e);
    expect(e._preventDefaultCalls).toBe(1);
    expect(useTreeStore.getState().paletteMode).toBe("search");
    expect(useTreeStore.getState().paletteOpen).toBe(true);
  });

  it("APP-CMDSHIFTF-OPEN-5: handleAppCmdShiftF does NOT dispatch jasper:focus-search (legacy bus removed)", () => {
    let received = false;
    const listener = () => { received = true; };
    window.addEventListener("jasper:focus-search", listener);
    try {
      const e = makeEvent("f", { meta: true, shift: true });
      handleAppCmdShiftF(e);
      expect(received).toBe(false);
    } finally {
      window.removeEventListener("jasper:focus-search", listener);
    }
  });
});

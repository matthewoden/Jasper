/**
 * App-shell tests — Phase 2 composition. Phase 1's three-column grid is now
 * nested inside a flex column with the migration banner row above. We mock
 * the admin status hook so each test can drive the migration-banner branch
 * without spinning up real fetch.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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

import App, { handleAppF2KeyDown } from "./App";
import { useTreeStore } from "./lib/useTreeStore";

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

  it("A1: when status=ok, the locked three-column grid still renders inside the flex column", async () => {
    getAdminStatusMock.mockResolvedValue({
      data: { state: "ok", notes_indexed: 0 },
      error: undefined,
    });

    const { container } = render(<App />);
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
    // Phase 6 — Plan 06-07: right rail is now always present at RAIL_COLLAPSED_WIDTH (32px)
    // when collapsed (default). Grid template third column is 32px, not 0.
    expect(grid!.style.gridTemplateColumns).toBe("260px 1fr 32px");

    // Sidebar + RightRail anchors still mount.
    expect(screen.getByText("NOTES")).toBeInTheDocument();
    // Phase 3: the static Phase 1 "scratchpad" hardcoded sidebar row is
    // gone. With the mocked-empty tree we expect the FileTree empty
    // state to render in its place.
    expect(screen.getByTestId("tree-empty-state")).toBeInTheDocument();
    // Phase 6: BacklinksColumn (aria-hidden) is replaced by RightRail (no aria-hidden).
    // The collapsed RightRail renders an aside without aria-hidden.
    const aside = document.querySelector("aside");
    expect(aside).not.toBeNull();
  });

  it("A2: status=ok renders no banner and the editor textarea is enabled", async () => {
    getAdminStatusMock.mockResolvedValue({
      data: { state: "ok" },
      error: undefined,
    });

    render(<App />);
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

    render(<App />);
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

    render(<App />);
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

    render(<App />);
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
    render(<App />);
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
    render(<App />);
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
        const { unmount } = render(<App />);
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
      render(<App />);
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
    render(<App />);
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
    render(<App />);
    await waitFor(() => expect(capturedSessionSyncHandlers).not.toBeNull());
  });

  it("A-Phase4-2: onReindexStarted flips ReindexProgress to running (shows Rebuilding…)", async () => {
    render(<App />);
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
    render(<App />);
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

/**
 * TreeRow tests — UI-SPEC §Tree row anatomy + §Active row + §Hover state.
 *
 * The component receives a stub NodeApi shape (we cast as any since
 * react-arborist's NodeApi class is internal). Tests cover folder vs.
 * note variants, single-click behavior, indent scaling, active-state
 * left-border, kebab placeholder + data-tree-row attributes for Plan
 * 03-07's context-menu hookup, and the no-dangerouslySetInnerHTML
 * gate (XSS hardening per the threat model).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

// Plan 08-06 (D-26): TreeRow now consumes useReveal() which requires a
// ToastProvider in the tree. Mock the hook at the module boundary so each
// test's render() call doesn't have to wrap in <ToastProvider>; the menu
// items wired through onReveal are exercised by the dedicated useReveal
// unit test (src/lib/useReveal.test.ts).
vi.mock("../lib/useReveal", () => ({
  useReveal: () => ({ reveal: vi.fn(), loading: false }),
}));

// Plan 08-10 (MCP-01 / MCP-02): TreeRow now consumes useMcpGrants() for
// the folder-row grant submenu + Sparkles indicator. The hook calls
// useToast() and listGrants() at mount; mock it here so the existing
// tree tests don't need a ToastProvider wrapper or a mocked API client.
// The dedicated hook unit tests live in src/lib/useMcpGrants.test.ts;
// the indicator component tests live in McpGrantIndicator.test.tsx.
vi.mock("../lib/useMcpGrants", () => ({
  useMcpGrants: () => ({
    grants: [],
    refresh: vi.fn(),
    grant: vi.fn(),
    revoke: vi.fn(),
    levelFor: () => null,
    directLevelFor: () => null,
    // R4-9 (Plan 08-22) — new ancestor-grant helper consumed by
    // TreeRow's folder-row branch. Default to null (no inherited
    // grant) so existing test fixtures stay representative of the
    // common no-grant case.
    inheritedGrantOn: () => null,
  }),
}));

import { useTreeStore } from "../lib/useTreeStore";
import { TreeRow } from "./TreeRow";
// Vite ?raw suffix loads the file's source as a string at build time —
// gives the XSS-hardening test a way to scan TreeRow.tsx for the
// forbidden inner-HTML escape hatch without reaching for node:fs.
import treeRowSource from "./TreeRow.tsx?raw";

// Stub the react-arborist NodeApi shape — only the fields TreeRow reads.
function makeFolderNode(overrides: {
  path?: string;
  name?: string;
  level?: number;
  isOpen?: boolean;
  handleClick?: (e: unknown) => void;
} = {}) {
  const path = overrides.path ?? "projects";
  const name = overrides.name ?? path.split("/").slice(-1)[0];
  return {
    data: { kind: "folder" as const, path, name },
    level: overrides.level ?? 0,
    isOpen: overrides.isOpen ?? false,
    toggle: vi.fn(),
    // UX-13 (Plan 07) — react-arborist's NodeApi.handleClick is what
    // dispatches Cmd/Ctrl/Shift multi-select. Stub it here so tests can
    // assert delegation occurred.
    handleClick: overrides.handleClick ?? vi.fn(),
  };
}

// Plan 07-26 — stub for kind="file" nodes (non-markdown files in the tree).
function makeFileNode(path: string, parentNoteId?: string) {
  const name = path.split("/").pop() ?? path;
  return {
    data: {
      kind: "file" as const,
      path,
      name,
      parentNoteId,
    },
    level: 1,
    isOpen: false,
    toggle: vi.fn(),
    handleClick: vi.fn(),
  };
}

function makeNoteNode(overrides: {
  id?: string;
  path?: string;
  title?: string;
  level?: number;
  handleClick?: (e: unknown) => void;
} = {}) {
  return {
    data: {
      kind: "note" as const,
      id: overrides.id ?? "uuid-1",
      path: overrides.path ?? "scratchpad.md",
      title: overrides.title ?? "Scratchpad",
    },
    level: overrides.level ?? 0,
    isOpen: false,
    toggle: vi.fn(),
    // UX-13 (Plan 07) — see makeFolderNode comment above.
    handleClick: overrides.handleClick ?? vi.fn(),
  };
}

beforeEach(() => {
  // Reset store between tests so activeNoteId / selectedRow / liveLabels don't leak.
  useTreeStore.setState({
    expanded: new Set(),
    activeNoteId: null,
    pendingRename: null,
    draftCreate: null,
    selectedRow: null,
    // Plan 04 (UX-08) — reset live H1 label overrides so the
    // "fall back to data.title" case is not contaminated by prior tests.
    liveLabels: {},
  });
});

describe("<TreeRow />", () => {
  it("TestRow_RendersFolder_WithChevronRightAndFolderIcon", () => {
    const node = makeFolderNode({ path: "projects", name: "projects" });
    const { container, getByText } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    expect(getByText("projects")).toBeInTheDocument();
    // Two svgs: ChevronRight + Folder. Verify by class names lucide injects.
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThanOrEqual(2);
    const classes = Array.from(svgs).map((s) => s.getAttribute("class") ?? "");
    expect(classes.some((c) => c.includes("chevron-right"))).toBe(true);
    expect(
      classes.some((c) => c.includes("lucide-folder") && !c.includes("folder-open")),
    ).toBe(true);
  });

  it("TestRow_RendersFolder_OpenSwapsIcons", () => {
    const node = makeFolderNode({
      path: "projects",
      name: "projects",
      isOpen: true,
    });
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    const classes = Array.from(container.querySelectorAll("svg")).map(
      (s) => s.getAttribute("class") ?? "",
    );
    expect(classes.some((c) => c.includes("chevron-down"))).toBe(true);
    expect(classes.some((c) => c.includes("folder-open"))).toBe(true);
  });

  it("TestRow_RendersNote_LabelOnly_NoChevronOrIcon", () => {
    const node = makeNoteNode();
    const { container, getByText } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    expect(getByText("Scratchpad")).toBeInTheDocument();
    const svgs = Array.from(container.querySelectorAll("svg"));
    const classes = svgs.map((s) => s.getAttribute("class") ?? "");
    // No chevron, no folder/folder-open icon on note rows. The kebab
    // (MoreHorizontal) IS rendered (hidden via class until hover) — that's
    // the only svg expected on a note row.
    expect(classes.some((c) => c.includes("chevron"))).toBe(false);
    expect(classes.some((c) => c.includes("lucide-folder"))).toBe(false);
  });

  it("TestRow_NoteRow_HasSpacerForAlignment", () => {
    const node = makeNoteNode();
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    // The first <span> with width: 16 inside the row is the chevron-spacer
    // that keeps note-row labels aligned with their parent folder labels.
    const spacers = Array.from(
      container.querySelectorAll("span[aria-hidden='true']"),
    ) as HTMLElement[];
    const widthSixteenSpacer = spacers.find((el) => el.style.width === "16px");
    expect(widthSixteenSpacer).toBeDefined();
  });

  it("TestRow_FolderClick_TogglesNode", () => {
    const node = makeFolderNode();
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    const row = container.querySelector("[data-tree-row]") as HTMLElement;
    fireEvent.click(row);
    expect(node.toggle).toHaveBeenCalledTimes(1);
  });

  it("TestRow_NoteClick_CallsOnSelectNote", () => {
    const node = makeNoteNode({ id: "uuid-1" });
    const onSelectNote = vi.fn();
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={onSelectNote}
      />,
    );
    const row = container.querySelector("[data-tree-row]") as HTMLElement;
    fireEvent.click(row);
    expect(onSelectNote).toHaveBeenCalledWith("uuid-1");
  });

  it("TestRow_NoteClick_SetsActiveNoteInStore", () => {
    const node = makeNoteNode({ id: "uuid-2" });
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    const row = container.querySelector("[data-tree-row]") as HTMLElement;
    fireEvent.click(row);
    expect(useTreeStore.getState().activeNoteId).toBe("uuid-2");
  });

  it("TestRow_ActiveNoteRow_RendersLeftBorder", () => {
    useTreeStore.setState({ activeNoteId: "uuid-1" });
    const node = makeNoteNode({ id: "uuid-1" });
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    // Active rows render an absolutely-positioned 2px-wide span with
    // background --color-accent on the row's left edge.
    const spans = Array.from(
      container.querySelectorAll("span[aria-hidden='true']"),
    ) as HTMLElement[];
    const activeBorder = spans.find(
      (el) =>
        el.style.width === "2px" &&
        (el.style.background.includes("--color-accent") ||
          el.style.background.includes("color-accent")),
    );
    expect(activeBorder).toBeDefined();
  });

  it("TestRow_LabelTitleAttr — folder", () => {
    const node = makeFolderNode({ path: "projects", name: "projects" });
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    const label = container.querySelector(
      "[data-tree-row-label]",
    ) as HTMLElement;
    expect(label.getAttribute("title")).toBe("projects");
  });

  it("TestRow_LabelTitleAttr — note", () => {
    const node = makeNoteNode({ title: "Scratchpad" });
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    const label = container.querySelector(
      "[data-tree-row-label]",
    ) as HTMLElement;
    expect(label.getAttribute("title")).toBe("Scratchpad");
  });

  it("TestRow_KebabHasDataAttribute", () => {
    const node = makeNoteNode();
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    const kebab = container.querySelector("[data-tree-row-kebab]");
    expect(kebab).not.toBeNull();
    expect(kebab?.tagName).toBe("BUTTON");
  });

  it("TestRow_RowHasDataAttribute — note uses id, folder uses path", () => {
    const noteNode = makeNoteNode({ id: "uuid-99" });
    const { container: nc } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={noteNode as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    expect(
      nc.querySelector("[data-tree-row]")?.getAttribute("data-tree-row"),
    ).toBe("uuid-99");

    const folderNode = makeFolderNode({ path: "projects/jasper" });
    const { container: fc } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={folderNode as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    expect(
      fc.querySelector("[data-tree-row]")?.getAttribute("data-tree-row"),
    ).toBe("projects/jasper");
  });

  it("TestRow_IndentScalesWithLevel — level=2 → paddingLeft=48", () => {
    const node = makeFolderNode({ level: 2 });
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    const row = container.querySelector("[data-tree-row]") as HTMLElement;
    expect(row.style.paddingLeft).toBe("48px");
  });

  it("TestRow_DoesNotUseDangerouslySetInnerHTML — XSS hardening per T-03-04-05/T-03-06-01", () => {
    // The forbidden token is split across two pieces so this test source
    // can mention the family of escape hatches in comments without
    // making the assertion trivially true.
    const FORBIDDEN = "dangerously" + "SetInnerHTML";
    expect(treeRowSource).not.toContain(FORBIDDEN);
  });

  it("applies the react-arborist style prop to the row root for virtualization", () => {
    const node = makeNoteNode();
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{ position: "absolute", top: 96 }}
        onSelectNote={vi.fn()}
      />,
    );
    const row = container.querySelector("[data-tree-row]") as HTMLElement;
    expect(row.style.top).toBe("96px");
  });

  // ──────────────────────────────────────────────────────────────────
  // Plan 03-07 — interaction wiring (context menu, kebab dropdown,
  // F2/Backspace, double-click, RenameInput slot).
  // ──────────────────────────────────────────────────────────────────

  it("TestRow_RightClickOpensContextMenu", async () => {
    const node = makeNoteNode();
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    const row = container.querySelector("[data-tree-row]") as HTMLElement;
    fireEvent.contextMenu(row);
    // Radix portals the context-menu content; use document-wide query.
    const open = await import("@testing-library/react").then((m) =>
      m.screen.findByText("Open"),
    );
    expect(open).toBeInTheDocument();
  });

  it("TestRow_KebabClickOpensDropdown", async () => {
    const node = makeNoteNode();
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    const kebab = container.querySelector(
      "[data-tree-row-kebab]",
    ) as HTMLElement;
    // Radix DropdownMenu.Trigger listens for pointerdown to open the
    // menu; jsdom's fireEvent.click alone doesn't fire pointer events.
    fireEvent.pointerDown(kebab, { button: 0 });
    fireEvent.click(kebab);
    const open = await import("@testing-library/react").then((m) =>
      m.screen.findByText("Open"),
    );
    expect(open).toBeInTheDocument();
  });

  it("TestRow_F2KeyTriggersRename", () => {
    const onRequestRename = vi.fn();
    const node = makeNoteNode();
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
        onRequestRename={onRequestRename}
      />,
    );
    const row = container.querySelector("[data-tree-row]") as HTMLElement;
    fireEvent.keyDown(row, { key: "F2" });
    expect(onRequestRename).toHaveBeenCalledWith(node.data);
  });

  it("TestRow_BackspaceTriggersDelete", () => {
    const onRequestDelete = vi.fn();
    const node = makeNoteNode();
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
        onRequestDelete={onRequestDelete}
      />,
    );
    const row = container.querySelector("[data-tree-row]") as HTMLElement;
    fireEvent.keyDown(row, { key: "Backspace" });
    expect(onRequestDelete).toHaveBeenCalledWith(node.data);
  });

  it("TestRow_DoubleClickTriggersRename", () => {
    const onRequestRename = vi.fn();
    const node = makeNoteNode();
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
        onRequestRename={onRequestRename}
      />,
    );
    const row = container.querySelector("[data-tree-row]") as HTMLElement;
    fireEvent.doubleClick(row);
    expect(onRequestRename).toHaveBeenCalledWith(node.data);
  });

  it("TestRow_PendingRenameRendersInput — note", () => {
    useTreeStore.setState({
      pendingRename: { kind: "note", target: "uuid-9" },
    });
    const node = makeNoteNode({ id: "uuid-9", title: "scratchpad.md" });
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
        siblingNames={[]}
      />,
    );
    // The label span is replaced by an <input>.
    const input = container.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    // For notes, the .md extension is stripped before display.
    expect(input.value).toBe("scratchpad");
  });

  it("TestRow_PendingRenameRendersInput — folder", () => {
    useTreeStore.setState({
      pendingRename: { kind: "folder", target: "projects" },
    });
    const node = makeFolderNode({ path: "projects", name: "projects" });
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
        siblingNames={[]}
      />,
    );
    const input = container.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("projects");
  });

  it("TestRow_RenameInputCommit_CallsCommitRename", async () => {
    useTreeStore.setState({
      pendingRename: { kind: "note", target: "uuid-9" },
    });
    const commitRename = vi.fn().mockResolvedValue(undefined);
    const node = makeNoteNode({ id: "uuid-9", title: "scratchpad.md" });
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
        siblingNames={[]}
        commitRename={commitRename}
      />,
    );
    const input = container.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await import("@testing-library/react").then((m) =>
      m.waitFor(() => {
        expect(commitRename).toHaveBeenCalledWith(node.data, "renamed");
      }),
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // Plan 03-12 Gap 3 — F2 / Backspace key plumbing.
  //
  // The 03-07 SUMMARY claims F2 / Backspace bindings reach
  // onRequestRename / onRequestDelete, but in Phase 3 human-UAT
  // (Finding F.1) F2 with a tree row focused did nothing. Diagnosis:
  // either react-arborist's keymap intercepts F2 first or focus lives
  // on document.body, never reaching the row's onKeyDown. Fix:
  // TreeRow's handleKeyDown must call BOTH preventDefault AND
  // stopPropagation so neither React's continuation nor arborist's
  // bubble listener also handles the key.
  // ──────────────────────────────────────────────────────────────────

  describe("F2 / Backspace key plumbing (Gap 3)", () => {
    it("F2 with row focused fires onRequestRename once", () => {
      const onRequestRename = vi.fn();
      const node = makeNoteNode({ id: "n1", path: "x.md", title: "x" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
          onRequestRename={onRequestRename}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      row.focus();
      fireEvent.keyDown(row, { key: "F2" });
      expect(onRequestRename).toHaveBeenCalledTimes(1);
      expect(onRequestRename).toHaveBeenCalledWith(node.data);
    });

    it("F2 does not bubble to parent (stopPropagation)", () => {
      const parentKeyDown = vi.fn();
      const onRequestRename = vi.fn();
      const node = makeNoteNode({ id: "n1", path: "x.md", title: "x" });
      const { container } = render(
        <div onKeyDown={parentKeyDown}>
          <TreeRow
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            node={node as any}
            style={{}}
            onSelectNote={vi.fn()}
            onRequestRename={onRequestRename}
          />
        </div>,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      row.focus();
      fireEvent.keyDown(row, { key: "F2" });
      expect(onRequestRename).toHaveBeenCalledTimes(1);
      expect(parentKeyDown).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Plan 03-16 Gap R2-1 — drag-and-drop dead in browser.
  //
  // Root cause (verified in 03-RESEARCH-ROUND2.md §1): TreeRow never
  // attached react-arborist's `dragHandle` callback ref to a DOM node,
  // so react-dnd's HTML5Backend never registered the row as a drag
  // source. Fix: TreeRow accepts an optional `dragHandle` prop and
  // attaches it as `ref={dragHandle}` on the row container <div>.
  //
  // These tests prove the wiring without exercising real DnD events
  // (synthetic DnD events do NOT round-trip through HTML5Backend in
  // jsdom — that's why Gap R2-1 needs manual UAT to fully verify; see
  // 03-15-SUMMARY for the documented limitation).
  // ──────────────────────────────────────────────────────────────────

  describe("dragHandle wiring (Gap R2-1)", () => {
    it("invokes dragHandle with a non-null HTMLDivElement on mount", () => {
      const spy = vi.fn<(el: HTMLDivElement | null) => void>();
      const node = makeNoteNode();
      render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
          dragHandle={spy}
        />,
      );
      // React invokes a callback ref once with the element on mount.
      // (StrictMode would invoke it again with null then with the
      // element — but the test renderer here is not in StrictMode, so
      // a single call with the HTMLDivElement is the contract.)
      expect(spy).toHaveBeenCalled();
      // The most recent non-null call must hand us the row container
      // <div> — that's the DOM node react-dnd's HTML5Backend will
      // register as a drag source.
      const nonNullCalls = spy.mock.calls.filter((c) => c[0] !== null);
      expect(nonNullCalls.length).toBeGreaterThanOrEqual(1);
      const lastEl = nonNullCalls[nonNullCalls.length - 1]![0];
      expect(lastEl).toBeInstanceOf(HTMLDivElement);
      // Sanity: the element handed to dragHandle must be the same row
      // container that carries the data-tree-row marker. Without this,
      // we could be attaching the ref to the wrong inner div. Note
      // rows put their UUID id on data-tree-row (folder rows put path).
      expect(lastEl!.getAttribute("data-tree-row")).toBe(node.data.id);
    });

    it("does not throw when dragHandle is omitted (prop is optional)", () => {
      // react-arborist always provides dragHandle, but the existing
      // unit tests across this file render TreeRow without it. The
      // prop addition must remain optional so they keep working.
      const node = makeNoteNode();
      expect(() =>
        render(
          <TreeRow
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            node={node as any}
            style={{}}
            onSelectNote={vi.fn()}
          />,
        ),
      ).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Plan 03-20 Gap R2-4 — selectedRow population on row click.
  //
  // Clicking a tree row populates useTreeStore.selectedRow so App.tsx's
  // document-level F2 listener can route rename to the right row even
  // after the editor textarea has stolen focus
  // (EditorPane.useEffect → loadStatus === "loaded"). The local
  // handleKeyDown F2 path (Plan 03-12) stays as a fallback for the
  // auto-focused-row case.
  // ──────────────────────────────────────────────────────────────────
  describe("selectedRow on click (Gap R2-4)", () => {
    it("note row click sets selectedRow to {kind:'note', target:<id>}", () => {
      const node = makeNoteNode({ id: "uuid-77" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      fireEvent.click(row);
      expect(useTreeStore.getState().selectedRow).toEqual({
        kind: "note",
        target: "uuid-77",
      });
    });

    it("folder row click sets selectedRow to {kind:'folder', target:<path>}", () => {
      const node = makeFolderNode({ path: "projects/jasper" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      fireEvent.click(row);
      expect(useTreeStore.getState().selectedRow).toEqual({
        kind: "folder",
        target: "projects/jasper",
      });
    });

    it("clicking a row currently in rename mode does NOT change selectedRow", () => {
      // Pre-seed selectedRow to a different value, then mount the row
      // in rename mode and click it. Because handleClick short-circuits
      // on isRenamingThis, setSelectedRow must not fire — the previous
      // selection survives.
      useTreeStore.setState({
        pendingRename: { kind: "note", target: "uuid-9" },
        selectedRow: { kind: "folder", target: "previous/selection" },
      });
      const node = makeNoteNode({ id: "uuid-9", title: "scratchpad.md" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
          siblingNames={[]}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      fireEvent.click(row);
      // Unchanged — the renaming-this short-circuit fires first.
      expect(useTreeStore.getState().selectedRow).toEqual({
        kind: "folder",
        target: "previous/selection",
      });
    });

    it("note row click also still calls onSelectNote and sets activeNoteId (no regression)", () => {
      const onSelectNote = vi.fn();
      const node = makeNoteNode({ id: "uuid-pre-existing" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={onSelectNote}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      fireEvent.click(row);
      expect(onSelectNote).toHaveBeenCalledWith("uuid-pre-existing");
      expect(useTreeStore.getState().activeNoteId).toBe("uuid-pre-existing");
      expect(useTreeStore.getState().selectedRow).toEqual({
        kind: "note",
        target: "uuid-pre-existing",
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Phase 5.5 / Plan 04 (UX-08) — live H1 label override for note rows.
  //
  // Note rows render `liveLabels[id] ?? data.title`. Folder rows are
  // unaffected (they always render `data.name`). The selector returns
  // undefined for folder rows by construction, but we add a defensive
  // test to prove it.
  // ──────────────────────────────────────────────────────────────────
  describe("UX-08 live H1 label override", () => {
    it("UX-08: note row renders liveLabels[id] when present", () => {
      useTreeStore.setState({
        liveLabels: { "n-1": "Live Title" },
      });
      const node = makeNoteNode({ id: "n-1", title: "Disk Title" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const label = container.querySelector(
        "[data-tree-row-label]",
      ) as HTMLElement;
      expect(label.textContent).toBe("Live Title");
      // The title attribute must mirror the displayed label so the
      // hover-tooltip matches what the user sees.
      expect(label.getAttribute("title")).toBe("Live Title");
    });

    it("UX-08: note row falls back to data.title when liveLabel is absent", () => {
      // Reset liveLabels explicitly so prior tests cannot leak in.
      useTreeStore.setState({ liveLabels: {} });
      const node = makeNoteNode({ id: "n-1", title: "Disk Title" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const label = container.querySelector(
        "[data-tree-row-label]",
      ) as HTMLElement;
      expect(label.textContent).toBe("Disk Title");
      expect(label.getAttribute("title")).toBe("Disk Title");
    });

    it("UX-08: folder row ignores liveLabels (uses data.name) — defense-in-depth", () => {
      // setLiveLabel is keyed by note id only, so this case should never
      // happen at runtime — but the selector is defensive: it returns
      // undefined for folder rows regardless of the slice contents.
      useTreeStore.setState({
        liveLabels: { "projects/jasper": "Should NOT show" },
      });
      const node = makeFolderNode({
        path: "projects/jasper",
        name: "jasper",
      });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const label = container.querySelector(
        "[data-tree-row-label]",
      ) as HTMLElement;
      expect(label.textContent).toBe("jasper");
      expect(label.getAttribute("title")).toBe("jasper");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Phase 5.5 / Plan 07 (UX-13) — modifier-aware click delegation.
  //
  // Per RESEARCH §Pattern 4 + Pitfall 5 + §A4:
  //   - Cmd+click (Mac) / Ctrl+click (Win/Linux) / Shift+click MUST
  //     delegate to react-arborist's `node.handleClick(e)` and SKIP the
  //     existing single-select pipeline. Doing both would unintentionally
  //     switch the active note while the user is only multi-selecting.
  //   - Plain click (no modifier) preserves the existing pipeline:
  //     setSelectedRow → toggle (folder) or onSelectNote + setActiveNote (note).
  // ──────────────────────────────────────────────────────────────────
  describe("UX-13 modifier-aware multi-select click delegation (Plan 07)", () => {
    it("UX-13: Cmd+click delegates to node.handleClick and does NOT call onSelectNote", () => {
      const handleClick = vi.fn();
      const onSelectNote = vi.fn();
      const node = makeNoteNode({ id: "uuid-cmd", handleClick });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={onSelectNote}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      fireEvent.click(row, { metaKey: true });
      // Delegated to arborist's multi-select dispatch.
      expect(handleClick).toHaveBeenCalledTimes(1);
      // Must NOT switch the active note — Pitfall 5.
      expect(onSelectNote).not.toHaveBeenCalled();
      expect(useTreeStore.getState().activeNoteId).toBeNull();
    });

    it("UX-13: Ctrl+click delegates to node.handleClick (cross-platform)", () => {
      // RESEARCH §A4: Cmd on Mac, Ctrl on Win/Linux. We accept either.
      const handleClick = vi.fn();
      const onSelectNote = vi.fn();
      const node = makeNoteNode({ id: "uuid-ctrl", handleClick });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={onSelectNote}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      fireEvent.click(row, { ctrlKey: true });
      expect(handleClick).toHaveBeenCalledTimes(1);
      expect(onSelectNote).not.toHaveBeenCalled();
      expect(useTreeStore.getState().activeNoteId).toBeNull();
    });

    it("UX-13: Shift+click delegates to node.handleClick", () => {
      const handleClick = vi.fn();
      const onSelectNote = vi.fn();
      const node = makeNoteNode({ id: "uuid-shift", handleClick });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={onSelectNote}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      fireEvent.click(row, { shiftKey: true });
      expect(handleClick).toHaveBeenCalledTimes(1);
      expect(onSelectNote).not.toHaveBeenCalled();
      expect(useTreeStore.getState().activeNoteId).toBeNull();
    });

    it("UX-13: plain click (no modifier) preserves existing single-select pipeline", () => {
      const handleClick = vi.fn();
      const onSelectNote = vi.fn();
      const node = makeNoteNode({ id: "uuid-plain", handleClick });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={onSelectNote}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      fireEvent.click(row);
      // Arborist's multi-select dispatch must NOT have been called.
      expect(handleClick).not.toHaveBeenCalled();
      // The pre-existing single-select pipeline still runs.
      expect(onSelectNote).toHaveBeenCalledWith("uuid-plain");
      expect(useTreeStore.getState().activeNoteId).toBe("uuid-plain");
      expect(useTreeStore.getState().selectedRow).toEqual({
        kind: "note",
        target: "uuid-plain",
      });
    });

    it("UX-13: plain click on folder still toggles open (regression guard)", () => {
      const handleClick = vi.fn();
      const node = makeFolderNode({
        path: "projects",
        name: "projects",
        handleClick,
      });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      fireEvent.click(row);
      // No-modifier branch: toggle fires, arborist multi-select does NOT.
      expect(node.toggle).toHaveBeenCalledTimes(1);
      expect(handleClick).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Phase 5.5 gap-closure Plan 10 — Mac Ctrl-click context-menu gate (WR-01)
  //
  // On macOS, Ctrl-click is the OS-level secondary-click gesture that
  // opens the right-click context menu. The previous
  // `isModifierClick = e.metaKey || e.ctrlKey || e.shiftKey;` treated
  // Ctrl-click as multi-select on every platform, hijacking the OS
  // context-menu gesture for Mac users on a single-button trackpad.
  //
  // Fix: gate ctrlKey on `!isMac`. Mac users keep multi-select via
  // Cmd-click (metaKey); Ctrl-click on Mac falls through to the
  // no-modifier branch (which lets the contextmenu event fire normally).
  // Other platforms keep both Ctrl and Cmd as multi-select modifiers.
  //
  // Platform detection convention: `navigator.platform` (matches the
  // existing convention in editor/jasperKeymap which references the
  // same property — both stub-able from tests).
  // ──────────────────────────────────────────────────────────────────
  describe("Phase 5.5 gap-closure Plan 10 — Mac Ctrl-click context-menu gate (WR-01)", () => {
    const originalNavigator = window.navigator;

    function setNavigatorPlatform(platform: string) {
      // jsdom's navigator.platform is read-only by default. Re-define
      // it on window.navigator so the production handler reads our
      // stub at click-time.
      Object.defineProperty(window, "navigator", {
        value: { ...originalNavigator, platform },
        configurable: true,
        writable: true,
      });
    }

    afterEach(() => {
      Object.defineProperty(window, "navigator", {
        value: originalNavigator,
        configurable: true,
        writable: true,
      });
    });

    it("WR-01: Mac Ctrl-click does NOT delegate to node.handleClick (falls through to single-click branch)", () => {
      setNavigatorPlatform("MacIntel");
      const handleClick = vi.fn();
      const onSelectNote = vi.fn();
      const node = makeNoteNode({ id: "uuid-mac-ctrl", handleClick });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={onSelectNote}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      fireEvent.click(row, { ctrlKey: true });
      // On Mac, Ctrl-click must NOT delegate to arborist's multi-select —
      // the OS treats it as a secondary-click gesture (contextmenu).
      expect(handleClick).not.toHaveBeenCalled();
      // The no-modifier single-click branch runs instead, so onSelectNote
      // and setActiveNote do fire (Pitfall 5 doesn't apply here — the
      // gate decided this is not a multi-select).
      expect(onSelectNote).toHaveBeenCalledWith("uuid-mac-ctrl");
      expect(useTreeStore.getState().activeNoteId).toBe("uuid-mac-ctrl");
    });

    it("WR-01: Mac Cmd-click STILL delegates to node.handleClick (multi-select preserved)", () => {
      setNavigatorPlatform("MacIntel");
      const handleClick = vi.fn();
      const onSelectNote = vi.fn();
      const node = makeNoteNode({ id: "uuid-mac-cmd", handleClick });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={onSelectNote}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      fireEvent.click(row, { metaKey: true });
      expect(handleClick).toHaveBeenCalledTimes(1);
      // Pitfall 5 — multi-select must NOT also switch the active note.
      expect(onSelectNote).not.toHaveBeenCalled();
      expect(useTreeStore.getState().activeNoteId).toBeNull();
    });

    it("WR-01: non-Mac Ctrl-click STILL delegates to node.handleClick (cross-platform multi-select)", () => {
      setNavigatorPlatform("Linux x86_64");
      const handleClick = vi.fn();
      const onSelectNote = vi.fn();
      const node = makeNoteNode({ id: "uuid-linux-ctrl", handleClick });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={onSelectNote}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      fireEvent.click(row, { ctrlKey: true });
      expect(handleClick).toHaveBeenCalledTimes(1);
      expect(onSelectNote).not.toHaveBeenCalled();
      expect(useTreeStore.getState().activeNoteId).toBeNull();
    });

    it("WR-01: non-Mac Ctrl-click on Win32 platform also delegates", () => {
      // Defense-in-depth: the gate keys off `isMac`, not specific
      // non-Mac strings. Verify Win32 hits the same delegated path.
      setNavigatorPlatform("Win32");
      const handleClick = vi.fn();
      const node = makeNoteNode({ id: "uuid-win-ctrl", handleClick });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      fireEvent.click(row, { ctrlKey: true });
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it("WR-01: Shift-click delegates on every platform (range-select preserved)", () => {
      // Shift-click is range-select on every OS — the WR-01 gate must
      // not affect shiftKey behavior. Test on MacIntel to prove the
      // Mac-specific gate scoped to ctrlKey only.
      setNavigatorPlatform("MacIntel");
      const handleClick = vi.fn();
      const node = makeNoteNode({ id: "uuid-mac-shift", handleClick });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      fireEvent.click(row, { shiftKey: true });
      expect(handleClick).toHaveBeenCalledTimes(1);
    });
  });

  // ── Phase 7 D-18: root-level daily/ folder CalendarDays icon ──────────
  describe("Phase 7 D-18: daily/ folder icon", () => {
    it("TestRow_DailyFolder_RooLevel_ShowsCalendarDaysIcon", () => {
      const node = makeFolderNode({ path: "daily", name: "daily" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      // CalendarDays SVG carries the class "lucide-calendar-days"
      const svgs = container.querySelectorAll("svg");
      const classes = Array.from(svgs).map((s) => s.getAttribute("class") ?? "");
      expect(classes.some((c) => c.includes("lucide-calendar-days"))).toBe(true);
    });

    it("TestRow_DailyFolder_RootLevel_IconColorIsAccent", () => {
      const node = makeFolderNode({ path: "daily", name: "daily" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const svgs = container.querySelectorAll("svg");
      const calendarSvg = Array.from(svgs).find(
        (s) => s.getAttribute("class")?.includes("lucide-calendar-days"),
      );
      expect(calendarSvg).toBeTruthy();
      // Icon color is applied via inline style on the SVG
      expect(calendarSvg!.getAttribute("style")).toContain("var(--color-accent)");
    });

    it("TestRow_DailyFolder_RootLevel_HasDailyNotesTooltip", () => {
      const node = makeFolderNode({ path: "daily", name: "daily" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const row = container.querySelector('[title="Daily notes"]');
      expect(row).toBeTruthy();
    });

    it("TestRow_SubFolder_Named_daily_KeepsDefaultFolderIcon", () => {
      // "archive/daily" — sub-path; should NOT get CalendarDays.
      const node = makeFolderNode({ path: "archive/daily", name: "daily" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const svgs = container.querySelectorAll("svg");
      const classes = Array.from(svgs).map((s) => s.getAttribute("class") ?? "");
      // Must NOT have CalendarDays; must have regular Folder icon
      expect(classes.some((c) => c.includes("lucide-calendar-days"))).toBe(false);
      expect(
        classes.some(
          (c) => c.includes("lucide-folder") && !c.includes("folder-open"),
        ),
      ).toBe(true);
    });

    it("TestRow_SubFolder_Named_daily_HasNoTooltip", () => {
      const node = makeFolderNode({ path: "archive/daily", name: "daily" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      // The row div should NOT have title="Daily notes"
      const row = container.querySelector('[title="Daily notes"]');
      expect(row).toBeNull();
    });

    it("TestRow_OtherRootFolder_KeepsDefaultFolderIcon", () => {
      // "projects" — different root folder; must not get CalendarDays.
      const node = makeFolderNode({ path: "projects", name: "projects" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const svgs = container.querySelectorAll("svg");
      const classes = Array.from(svgs).map((s) => s.getAttribute("class") ?? "");
      expect(classes.some((c) => c.includes("lucide-calendar-days"))).toBe(false);
    });

    // Plan 07-20 (UAT #13 C4): attachments folders get the Paperclip icon.
    it("TestRow_AttachmentsFolder_RendersPaperclipIcon", () => {
      // Nested attachments folder — name is "attachments" but path has parent prefix.
      const node = makeFolderNode({
        path: "projects/jasper/attachments",
        name: "attachments",
      });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const svgs = container.querySelectorAll("svg");
      const classes = Array.from(svgs).map((s) => s.getAttribute("class") ?? "");
      // Lucide renders Paperclip as an SVG with class "lucide lucide-paperclip"
      expect(classes.some((c) => c.includes("lucide-paperclip"))).toBe(true);
      // Must NOT use the CalendarDays icon
      expect(classes.some((c) => c.includes("lucide-calendar-days"))).toBe(false);
      // Must NOT use the default Folder/FolderOpen icons
      expect(classes.some((c) => c.includes("lucide-folder"))).toBe(false);
    });

    it("TestRow_RootAttachmentsFolder_RendersPaperclipIcon", () => {
      // Root-level attachments folder — path === "attachments"
      const node = makeFolderNode({ path: "attachments", name: "attachments" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const svgs = container.querySelectorAll("svg");
      const classes = Array.from(svgs).map((s) => s.getAttribute("class") ?? "");
      expect(classes.some((c) => c.includes("lucide-paperclip"))).toBe(true);
    });

    it("TestRow_NonAttachmentsFolder_DoesNotRenderPaperclip", () => {
      // A folder named "assets" (not "attachments") must not get Paperclip
      const node = makeFolderNode({ path: "assets", name: "assets" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const svgs = container.querySelectorAll("svg");
      const classes = Array.from(svgs).map((s) => s.getAttribute("class") ?? "");
      expect(classes.some((c) => c.includes("lucide-paperclip"))).toBe(false);
      expect(classes.some((c) => c.includes("lucide-folder"))).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Plan 07-26 (UAT-2 R1-7) — kind="file" rendering tests
  // ─────────────────────────────────────────────────────────────────────
  describe("TR-file — kind='file' rendering (UAT-2 R1-7)", () => {
    it("TR-file-1: renders Image icon for .png file", () => {
      const node = makeFileNode("img.png");
      const { container } = render(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <TreeRow node={node as any} style={{}} onSelectNote={vi.fn()} />,
      );
      const svgs = container.querySelectorAll("svg");
      const classes = Array.from(svgs).map((s) => s.getAttribute("class") ?? "");
      expect(classes.some((c) => c.includes("lucide-image"))).toBe(true);
    });

    it("TR-file-2: renders FileText icon for .pdf file", () => {
      const node = makeFileNode("doc.pdf");
      const { container } = render(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <TreeRow node={node as any} style={{}} onSelectNote={vi.fn()} />,
      );
      const svgs = container.querySelectorAll("svg");
      const classes = Array.from(svgs).map((s) => s.getAttribute("class") ?? "");
      expect(classes.some((c) => c.includes("lucide-file-text"))).toBe(true);
    });

    it("TR-file-3: renders generic File icon for unknown extension", () => {
      const node = makeFileNode("blob.bin");
      const { container } = render(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <TreeRow node={node as any} style={{}} onSelectNote={vi.fn()} />,
      );
      const svgs = container.querySelectorAll("svg");
      const classes = Array.from(svgs).map((s) => s.getAttribute("class") ?? "");
      // Should render generic file icon (lucide-file, not lucide-image or lucide-file-text)
      expect(classes.some((c) => c.includes("lucide-file") && !c.includes("lucide-file-text"))).toBe(true);
    });

    // Plan 07-32b (UAT-3 R7) — SUPERSEDES the Plan 07-26 window.open contract.
    // Clicking any non-markdown file row now sets useTreeStore.activeFilePath
    // (the middle pane renders FilePreviewView) and MUST NOT call window.open.
    it("TR-FILECLICK-1: clicking a file row calls setActiveFilePath(data.path)", () => {
      const setActiveFilePathSpy = vi.fn();
      // Patch the store action to spy on calls without breaking other tests
      // (beforeEach resets the store state but not action implementations).
      const origSet = useTreeStore.getState().setActiveFilePath;
      useTreeStore.setState({ setActiveFilePath: setActiveFilePathSpy });

      // File inside attachments/ folder with a parent note id (the parentNoteId
      // is now a dead-write field — handler doesn't read it).
      const node = makeFileNode("gallery/attachments/photo.png", "parent-note-uuid");
      render(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <TreeRow node={node as any} style={{}} onSelectNote={vi.fn()} />,
      );
      fireEvent.click(screen.getByRole("treeitem"));
      expect(setActiveFilePathSpy).toHaveBeenCalledWith("gallery/attachments/photo.png");

      // Restore the real action for other tests.
      useTreeStore.setState({ setActiveFilePath: origSet });
    });

    it("TR-FILECLICK-2: clicking a file row does NOT call window.open (Plan 07-32b supersedes Plan 07-26 popup contract)", () => {
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      const node = makeFileNode("gallery/attachments/photo.png", "parent-note-uuid");
      render(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <TreeRow node={node as any} style={{}} onSelectNote={vi.fn()} />,
      );
      fireEvent.click(screen.getByRole("treeitem"));
      expect(openSpy).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });

    it("TR-FILECLICK-3: clicking a non-attachment file ALSO calls setActiveFilePath (no parentNoteId required)", () => {
      // Plan 07-32b: the new endpoint is path-based, not noteId-based, so
      // vault-root files and files in non-attachments folders are all routable.
      const setActiveFilePathSpy = vi.fn();
      const origSet = useTreeStore.getState().setActiveFilePath;
      useTreeStore.setState({ setActiveFilePath: setActiveFilePathSpy });

      const node = makeFileNode("stray.pdf");
      render(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <TreeRow node={node as any} style={{}} onSelectNote={vi.fn()} />,
      );
      fireEvent.click(screen.getByRole("treeitem"));
      expect(setActiveFilePathSpy).toHaveBeenCalledWith("stray.pdf");

      useTreeStore.setState({ setActiveFilePath: origSet });
    });

    it("TR-file-6: file row shows filename as label", () => {
      const node = makeFileNode("some/path/report.pdf");
      render(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <TreeRow node={node as any} style={{}} onSelectNote={vi.fn()} />,
      );
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
    });

    // Plan 07-32b (UAT-3 R7) — note-click handler must explicitly clear
    // activeFilePath BEFORE calling setActiveNote (D-41 ADD-only compliance:
    // setActiveNote is unchanged, so callers do the reciprocal clearing).
    it("TR-NOTECLICK-1: clicking a note row calls setActiveFilePath(null) BEFORE setActiveNote(noteId)", () => {
      const setActiveFilePathSpy = vi.fn();
      const setActiveNoteSpy = vi.fn();

      const origSetAFP = useTreeStore.getState().setActiveFilePath;
      const origSetAN = useTreeStore.getState().setActiveNote;
      useTreeStore.setState({
        setActiveFilePath: setActiveFilePathSpy,
        setActiveNote: setActiveNoteSpy,
      });

      const node = makeNoteNode({ id: "uuid-note-1" });
      const onSelectNote = vi.fn();
      render(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <TreeRow node={node as any} style={{}} onSelectNote={onSelectNote} />,
      );
      fireEvent.click(screen.getByRole("treeitem"));

      expect(setActiveFilePathSpy).toHaveBeenCalledWith(null);
      expect(setActiveNoteSpy).toHaveBeenCalledWith("uuid-note-1");

      // Critical ordering check: setActiveFilePath(null) MUST be invoked
      // BEFORE setActiveNote(uuid). Use mock.invocationCallOrder to assert.
      const afpOrder = setActiveFilePathSpy.mock.invocationCallOrder[0];
      const anOrder = setActiveNoteSpy.mock.invocationCallOrder[0];
      expect(afpOrder).toBeLessThan(anOrder);

      useTreeStore.setState({
        setActiveFilePath: origSetAFP,
        setActiveNote: origSetAN,
      });
    });
  });
});

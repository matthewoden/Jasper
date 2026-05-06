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
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

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
} = {}) {
  const path = overrides.path ?? "projects";
  const name = overrides.name ?? path.split("/").slice(-1)[0];
  return {
    data: { kind: "folder" as const, path, name },
    level: overrides.level ?? 0,
    isOpen: overrides.isOpen ?? false,
    toggle: vi.fn(),
  };
}

function makeNoteNode(overrides: {
  id?: string;
  path?: string;
  title?: string;
  level?: number;
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
  };
}

beforeEach(() => {
  // Reset store between tests so activeNoteId doesn't leak.
  useTreeStore.setState({
    expanded: new Set(),
    activeNoteId: null,
    pendingRename: null,
    draftCreate: null,
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
});

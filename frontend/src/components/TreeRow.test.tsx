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


vi.mock("../lib/useReveal", () => ({
  useReveal: () => ({ reveal: vi.fn(), loading: false }),
}));


vi.mock("../lib/useMcpGrants", () => ({
  useMcpGrants: () => ({
    grants: [],
    refresh: vi.fn(),
    grant: vi.fn(),
    revoke: vi.fn(),
    levelFor: () => null,
    directLevelFor: () => null,
    inheritedGrantOn: () => null,
  }),
}));

import { useTreeStore } from "../lib/useTreeStore";
import { TreeRow } from "./TreeRow";
import { TooltipProvider } from "./Tooltip";


import treeRowSource from "./TreeRow.tsx?raw";


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
    handleClick: overrides.handleClick ?? vi.fn(),
  };
}


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
  created?: string;
  updated_at?: string;
} = {}) {
  return {
    data: {
      kind: "note" as const,
      id: overrides.id ?? "uuid-1",
      path: overrides.path ?? "scratchpad.md",
      title: overrides.title ?? "Scratchpad",
      created: overrides.created,
      updated_at: overrides.updated_at,
    },
    level: overrides.level ?? 0,
    isOpen: false,
    toggle: vi.fn(),
    handleClick: overrides.handleClick ?? vi.fn(),
  };
}

beforeEach(() => {
  useTreeStore.setState({
    expanded: new Set(),
    activeNoteId: null,
    pendingRename: null,
    draftCreate: null,
    selectedRow: null,
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

  describe("D-15 indent guides", () => {
    it("level-0 row renders no indent guides", () => {
      const node = makeFolderNode({ path: "projects", name: "projects", level: 0 });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      expect(
        container.querySelectorAll('[data-testid="tree-indent-guide"]'),
      ).toHaveLength(0);
    });

    it("level-2 row renders exactly 2 indent guides at the expected left offsets", () => {
      const node = makeFolderNode({ path: "a/b/projects", name: "projects", level: 2 });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />,
      );
      const guides = Array.from(
        container.querySelectorAll('[data-testid="tree-indent-guide"]'),
      ) as HTMLElement[];
      expect(guides).toHaveLength(2);
      const lefts = guides.map((g) => g.style.left).sort();
      // left = 3 + 16*L + 7, for L in 0..1
      expect(lefts).toEqual(["10px", "26px"].sort());
    });
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

  it("TestRow_IndentScalesWithLevel — level=2 → paddingLeft=35 (base=3 + 16*level, Phase 27 follow-up fix round item 3)", () => {
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
    expect(row.style.paddingLeft).toBe("35px");
  });

  it("TestRow_IndentBaseOffset — level=0 → paddingLeft=3 (base derived from SidebarTabRow's 23px icon column minus the row's 20px chevron+gap offset)", () => {
    const node = makeFolderNode({ level: 0 });
    const { container } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={node as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    const row = container.querySelector("[data-tree-row]") as HTMLElement;
    expect(row.style.paddingLeft).toBe("3px");
  });

  it("TestRow_NoteAndFolderShareBaseIndent — note row's base offset matches folder's (label alignment preserved)", () => {
    const folderNode = makeFolderNode({ level: 1 });
    const { container: fc } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={folderNode as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    const noteNode = makeNoteNode({ level: 1 });
    const { container: nc } = render(
      <TreeRow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node={noteNode as any}
        style={{}}
        onSelectNote={vi.fn()}
      />,
    );
    const folderRow = fc.querySelector("[data-tree-row]") as HTMLElement;
    const noteRow = nc.querySelector("[data-tree-row]") as HTMLElement;
    expect(folderRow.style.paddingLeft).toBe(noteRow.style.paddingLeft);
    expect(folderRow.style.paddingLeft).toBe("19px");
  });

  it("TestRow_DoesNotUseDangerouslySetInnerHTML — XSS hardening per T-03-04-05/T-03-06-01", () => {
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
    const input = container.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
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
      expect(spy).toHaveBeenCalled();
      const nonNullCalls = spy.mock.calls.filter((c) => c[0] !== null);
      expect(nonNullCalls.length).toBeGreaterThanOrEqual(1);
      const lastEl = nonNullCalls[nonNullCalls.length - 1]![0];
      expect(lastEl).toBeInstanceOf(HTMLDivElement);
      expect(lastEl!.getAttribute("data-tree-row")).toBe(node.data.id);
    });

    it("does not throw when dragHandle is omitted (prop is optional)", () => {
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
      expect(label.getAttribute("title")).toBe("Live Title");
    });

    it("UX-08: note row falls back to data.title when liveLabel is absent", () => {
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
      expect(handleClick).toHaveBeenCalledTimes(1);
      expect(onSelectNote).not.toHaveBeenCalled();
      expect(useTreeStore.getState().activeNoteId).toBeNull();
    });

    it("UX-13: Ctrl+click delegates to node.handleClick (cross-platform)", () => {
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
      expect(handleClick).not.toHaveBeenCalled();
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
      expect(node.toggle).toHaveBeenCalledTimes(1);
      expect(handleClick).not.toHaveBeenCalled();
    });
  });

  describe("Phase 5.5 gap-closure Plan 10 — Mac Ctrl-click context-menu gate (WR-01)", () => {
    const originalNavigator = window.navigator;

    function setNavigatorPlatform(platform: string) {
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
      expect(handleClick).not.toHaveBeenCalled();
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
      const row = container.querySelector('[title="Daily notes"]');
      expect(row).toBeNull();
    });

    it("TestRow_OtherRootFolder_KeepsDefaultFolderIcon", () => {
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

    it("TestRow_AttachmentsFolder_RendersPaperclipIcon", () => {
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
      expect(classes.some((c) => c.includes("lucide-paperclip"))).toBe(true);
      expect(classes.some((c) => c.includes("lucide-calendar-days"))).toBe(false);
      expect(classes.some((c) => c.includes("lucide-folder"))).toBe(false);
    });

    it("TestRow_RootAttachmentsFolder_RendersPaperclipIcon", () => {
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
      expect(classes.some((c) => c.includes("lucide-file") && !c.includes("lucide-file-text"))).toBe(true);
    });

    it("TR-FILECLICK-1: clicking a file row calls setActiveFilePath(data.path)", () => {
      const setActiveFilePathSpy = vi.fn();
      const origSet = useTreeStore.getState().setActiveFilePath;
      useTreeStore.setState({ setActiveFilePath: setActiveFilePathSpy });

      const node = makeFileNode("gallery/attachments/photo.png", "parent-note-uuid");
      render(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <TreeRow node={node as any} style={{}} onSelectNote={vi.fn()} />,
      );
      fireEvent.click(screen.getByRole("treeitem"));
      expect(setActiveFilePathSpy).toHaveBeenCalledWith("gallery/attachments/photo.png");

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

      const afpOrder = setActiveFilePathSpy.mock.invocationCallOrder[0];
      const anOrder = setActiveNoteSpy.mock.invocationCallOrder[0];
      expect(afpOrder).toBeLessThan(anOrder);

      useTreeStore.setState({
        setActiveFilePath: origSetAFP,
        setActiveNote: origSetAN,
      });
    });
  });

  describe("Phase 19 — active row 12% accent tint + title-weight text (LSIDE-01)", () => {
    it("TR-ACTIVE-12PCT: active note row background uses 12% accent tint (bumped from 8%)", () => {
      useTreeStore.setState({ activeNoteId: "uuid-1" });
      const node = makeNoteNode({ id: "uuid-1" });
      const { container } = render(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <TreeRow node={node as any} style={{}} onSelectNote={vi.fn()} />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      expect(row.style.background).toBe(
        "color-mix(in srgb, var(--color-accent) 12%, transparent)",
      );
    });

    it("TR-ACTIVE-TITLECOLOR: active row label uses --color-fg-title, not plain --color-fg", () => {
      useTreeStore.setState({ activeNoteId: "uuid-1" });
      const node = makeNoteNode({ id: "uuid-1", title: "Scratchpad" });
      const { container } = render(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <TreeRow node={node as any} style={{}} onSelectNote={vi.fn()} />,
      );
      const label = container.querySelector(
        "[data-tree-row-label]",
      ) as HTMLElement;
      expect(label.style.color).toBe("var(--color-fg-title)");
    });

    it("TR-ACTIVE-REGRESSION: non-active note row has neither the 12% tint nor the title color", () => {
      useTreeStore.setState({ activeNoteId: null });
      const node = makeNoteNode({ id: "uuid-1", title: "Scratchpad" });
      const { container } = render(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <TreeRow node={node as any} style={{}} onSelectNote={vi.fn()} />,
      );
      const row = container.querySelector("[data-tree-row]") as HTMLElement;
      const label = container.querySelector(
        "[data-tree-row-label]",
      ) as HTMLElement;
      expect(row.style.background).not.toBe(
        "color-mix(in srgb, var(--color-accent) 12%, transparent)",
      );
      expect(label.style.color).not.toBe("var(--color-fg-title)");
      expect(label.style.color).toBe("var(--color-fg)");
    });
  });

  describe("Phase 30 — Bookmark toggle is prop-driven, not a per-row useBookmarks() call (Rule 1 fix)", () => {
    it("passes isNoteBookmarked(id) through to the kebab menu's Bookmark item label", async () => {
      const node = makeNoteNode({ id: "uuid-1" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
          isNoteBookmarked={(id) => id === "uuid-1"}
          onToggleNoteBookmark={vi.fn()}
        />,
      );
      const kebab = container.querySelector(
        "[data-tree-row-kebab]",
      ) as HTMLElement;
      fireEvent.pointerDown(kebab, { button: 0 });
      fireEvent.click(kebab);
      expect(await screen.findByText("Remove bookmark")).toBeInTheDocument();
    });

    it("calls onToggleNoteBookmark(id) when the Bookmark item is clicked", async () => {
      const onToggleNoteBookmark = vi.fn();
      const node = makeNoteNode({ id: "uuid-1" });
      const { container } = render(
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
          isNoteBookmarked={() => false}
          onToggleNoteBookmark={onToggleNoteBookmark}
        />,
      );
      const kebab = container.querySelector(
        "[data-tree-row-kebab]",
      ) as HTMLElement;
      fireEvent.pointerDown(kebab, { button: 0 });
      fireEvent.click(kebab);
      const bookmarkItem = await screen.findByText("Bookmark", { exact: true });
      fireEvent.click(bookmarkItem);
      expect(onToggleNoteBookmark).toHaveBeenCalledWith("uuid-1");
    });
  });
});

describe("UAT gap-closure group B, item 8: note-row created/modified hover tooltip", () => {
  it("shows Created + Modified in local time when both dates are present", () => {
    const created = "2026-01-05T12:00:00.000Z";
    const updatedAt = "2026-07-22T18:30:00.000Z";
    const node = makeNoteNode({ id: "uuid-1", created, updated_at: updatedAt });
    const { container } = render(
      <TooltipProvider>
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />
      </TooltipProvider>,
    );
    const label = container.querySelector(
      "[data-tree-row-label]",
    ) as HTMLElement;
    // A rich Tooltip wraps the label instead of the plain native title.
    expect(label.hasAttribute("title")).toBe(false);

    fireEvent.focus(label);

    // UAT round 2: "Created"/"Modified" labels and their date values now
    // render as separate nested spans (muted label, --color-fg date) so
    // the date VALUES are no longer dim — assert both parts independently
    // rather than the old single combined-text match.
    const expectedCreated = new Date(created).toLocaleString();
    const expectedModified = new Date(updatedAt).toLocaleString();
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.getByText(expectedCreated)).toBeInTheDocument();
    expect(screen.getByText("Modified")).toBeInTheDocument();
    expect(screen.getByText(expectedModified)).toBeInTheDocument();

    // UAT round 2 regression guard: the date VALUES must render at
    // --color-fg (legible), while the labels stay muted for hierarchy.
    expect(screen.getByText(expectedCreated).style.color).toBe(
      "var(--color-fg)",
    );
    expect(screen.getByText(expectedModified).style.color).toBe(
      "var(--color-fg)",
    );
    expect(screen.getByText("Created").style.color).toBe(
      "var(--color-muted)",
    );
    expect(screen.getByText("Modified").style.color).toBe(
      "var(--color-muted)",
    );
  });

  it("shows Modified only when `created` is missing", () => {
    const updatedAt = "2026-07-22T18:30:00.000Z";
    const node = makeNoteNode({ id: "uuid-1", updated_at: updatedAt });
    const { container } = render(
      <TooltipProvider>
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />
      </TooltipProvider>,
    );
    const label = container.querySelector(
      "[data-tree-row-label]",
    ) as HTMLElement;
    fireEvent.focus(label);

    expect(screen.getByText("Modified")).toBeInTheDocument();
    expect(
      screen.getByText(new Date(updatedAt).toLocaleString()),
    ).toBeInTheDocument();
    expect(screen.queryByText("Created")).not.toBeInTheDocument();
  });

  it("renders no tooltip (plain native title survives) when both dates are missing", () => {
    const node = makeNoteNode({ id: "uuid-1", title: "No Dates" });
    const { container } = render(
      <TooltipProvider>
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />
      </TooltipProvider>,
    );
    const label = container.querySelector(
      "[data-tree-row-label]",
    ) as HTMLElement;
    expect(label.getAttribute("title")).toBe("No Dates");
    fireEvent.focus(label);
    expect(screen.queryByText(/^Created /)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Modified /)).not.toBeInTheDocument();
  });

  it("folder rows are unaffected — no Tooltip wiring, native title still present", () => {
    const node = makeFolderNode({ path: "projects", name: "projects" });
    const { container } = render(
      <TooltipProvider>
        <TreeRow
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node={node as any}
          style={{}}
          onSelectNote={vi.fn()}
        />
      </TooltipProvider>,
    );
    const label = container.querySelector(
      "[data-tree-row-label]",
    ) as HTMLElement;
    expect(label.getAttribute("title")).toBe("projects");
  });
});

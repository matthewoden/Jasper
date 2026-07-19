/**
 * TreeView — onRootDrop unit tests (quick task 260719-jv1 follow-up:
 * bookmark drag-to-root).
 *
 * onRootDrop is OPT-IN: when a caller passes it, TreeView installs a
 * window-level native-drag listener set (mirroring FileTree's own
 * empty-area root-drop workaround for Bug A — react-arborist's onMove
 * never fires for a drop below the last row) scoped to THIS tree
 * instance's own `[role="tree"]` element. When omitted, no extra
 * listeners are installed.
 *
 * react-arborist's own DnD backend (react-dnd's HTML5Backend) ALSO
 * registers window-level dragstart/dragover/drop/dragend listeners
 * unconditionally on mount — dispatching real bubbling DragEvents in
 * jsdom would trip react-dnd's internal "Cannot call hover while not
 * dragging" invariant (it isn't a real drag), which is noise unrelated
 * to what we're testing here. So these tests capture the actual handler
 * functions TreeView registers (via a window.addEventListener spy —
 * TreeView's own effect runs AFTER react-arborist's child effects, per
 * React's child-before-parent effect ordering, so TreeView's listeners
 * are always the LAST ones registered for each event type) and invoke
 * them directly with a constructed event object. The real drag *gesture*
 * is proven with a real mouse in the browser (per the "verify DnD with
 * real mouse" memory) — these tests exercise the wiring only.
 */
import type { RefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { NodeApi, TreeApi } from "react-arborist";

import { TreeView, type TreeViewNode } from "./TreeView";
import type { BookmarkNodeData, TreeRowData } from "./TreeRow";

function makeNode(bookmarkId: string, title: string): TreeViewNode {
  return {
    id: "bookmark:" + bookmarkId,
    name: title,
    data: {
      kind: "bookmark",
      bookmarkId,
      noteId: "note-" + bookmarkId,
      title,
    } satisfies BookmarkNodeData,
  };
}

function renderRow({
  node,
  style,
  dragHandle,
}: {
  node: NodeApi<TreeRowData>;
  style: React.CSSProperties;
  dragHandle?: (el: HTMLDivElement | null) => void;
}) {
  const d = node.data as unknown as BookmarkNodeData;
  return (
    <div
      ref={dragHandle}
      style={style}
      data-tree-row={d.bookmarkId}
      data-tree-row-kind="bookmark"
    >
      {d.title}
    </div>
  );
}

type DragListenerType = "dragstart" | "dragover" | "drop" | "dragend";

/** Last-registered listener for a given window event type — TreeView's
 *  onRootDrop effect (parent) always registers after react-arborist's
 *  DnD backend (child), so the last call for a type is always ours. */
function lastHandlerFor(
  addSpy: ReturnType<typeof vi.spyOn>,
  type: DragListenerType,
): ((e: DragEvent) => void) | null {
  const calls = addSpy.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0] === type) return calls[i][1] as (e: DragEvent) => void;
  }
  return null;
}

function countByType(
  addSpy: ReturnType<typeof vi.spyOn>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [type] of addSpy.mock.calls) {
    const t = type as string;
    out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

async function renderTreeAndGetApi(
  onRootDrop?: (nodes: NodeApi<TreeViewNode>[]) => void,
): Promise<{
  api: TreeApi<TreeViewNode>;
  unmount: () => void;
}> {
  const treeRef = {
    current: null,
  } as unknown as RefObject<TreeApi<TreeViewNode> | null>;

  const { unmount } = render(
    <TreeView<TreeViewNode>
      data={[makeNode("a", "Alpha"), makeNode("b", "Beta")]}
      treeRef={treeRef}
      onRootDrop={onRootDrop}
      renderRow={renderRow}
    />,
  );

  await waitFor(() => {
    expect(treeRef.current).not.toBeNull();
  });

  return { api: treeRef.current as TreeApi<TreeViewNode>, unmount };
}

describe("TreeView onRootDrop", () => {
  it("invokes onRootDrop with the captured drag nodes on an empty-area drop (target inside the tree, not a row)", async () => {
    const onRootDrop = vi.fn();
    const addSpy = vi.spyOn(window, "addEventListener");
    const { api } = await renderTreeAndGetApi(onRootDrop);

    const fakeDragNodes = [
      { id: "bookmark:a", data: { data: makeNode("a", "Alpha").data } },
    ] as unknown as NodeApi<TreeViewNode>[];
    Object.defineProperty(api, "dragNodes", {
      get: () => fakeDragNodes,
      configurable: true,
    });

    const treeEl = document.querySelector('[role="tree"]') as HTMLElement;
    expect(treeEl).not.toBeNull();

    const dragstart = lastHandlerFor(addSpy, "dragstart");
    const dragover = lastHandlerFor(addSpy, "dragover");
    const drop = lastHandlerFor(addSpy, "drop");
    expect(dragstart).not.toBeNull();
    expect(dragover).not.toBeNull();
    expect(drop).not.toBeNull();

    dragstart!({} as DragEvent);

    const overPreventDefault = vi.fn();
    const overDataTransfer = { dropEffect: "none" };
    dragover!({
      target: treeEl,
      preventDefault: overPreventDefault,
      dataTransfer: overDataTransfer,
    } as unknown as DragEvent);
    expect(overPreventDefault).toHaveBeenCalled();
    expect(overDataTransfer.dropEffect).toBe("move");

    const dropPreventDefault = vi.fn();
    drop!({
      target: treeEl,
      preventDefault: dropPreventDefault,
    } as unknown as DragEvent);

    expect(dropPreventDefault).toHaveBeenCalled();
    expect(onRootDrop).toHaveBeenCalledTimes(1);
    expect(onRootDrop).toHaveBeenCalledWith(fakeDragNodes);
  });

  it("does NOT invoke onRootDrop when the drop target is a row (not the empty area)", async () => {
    const onRootDrop = vi.fn();
    const addSpy = vi.spyOn(window, "addEventListener");
    const { api } = await renderTreeAndGetApi(onRootDrop);

    const fakeDragNodes = [
      { id: "bookmark:a", data: { data: makeNode("a", "Alpha").data } },
    ] as unknown as NodeApi<TreeViewNode>[];
    Object.defineProperty(api, "dragNodes", {
      get: () => fakeDragNodes,
      configurable: true,
    });

    const row = document.querySelector('[data-tree-row="b"]') as HTMLElement;
    expect(row).not.toBeNull();

    const dragstart = lastHandlerFor(addSpy, "dragstart");
    const drop = lastHandlerFor(addSpy, "drop");
    dragstart!({} as DragEvent);
    drop!({ target: row, preventDefault: vi.fn() } as unknown as DragEvent);

    expect(onRootDrop).not.toHaveBeenCalled();
  });

  it("does not invoke onRootDrop for a drop outside this tree instance entirely", async () => {
    const onRootDrop = vi.fn();
    const addSpy = vi.spyOn(window, "addEventListener");
    const { api } = await renderTreeAndGetApi(onRootDrop);

    const fakeDragNodes = [
      { id: "bookmark:a", data: { data: makeNode("a", "Alpha").data } },
    ] as unknown as NodeApi<TreeViewNode>[];
    Object.defineProperty(api, "dragNodes", {
      get: () => fakeDragNodes,
      configurable: true,
    });

    const outsider = document.createElement("div");
    document.body.appendChild(outsider);

    const dragstart = lastHandlerFor(addSpy, "dragstart");
    const drop = lastHandlerFor(addSpy, "drop");
    dragstart!({} as DragEvent);
    drop!({
      target: outsider,
      preventDefault: vi.fn(),
    } as unknown as DragEvent);

    expect(onRootDrop).not.toHaveBeenCalled();
    outsider.remove();
  });

  it("installs exactly one extra window listener per drag-event type only when onRootDrop is provided", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");

    const { unmount: unmountWithout } = await renderTreeAndGetApi(undefined);
    const baseline = countByType(addSpy);
    unmountWithout();
    addSpy.mockClear();

    const { unmount: unmountWith } = await renderTreeAndGetApi(vi.fn());
    const withOnRootDrop = countByType(addSpy);
    unmountWith();

    for (const type of ["dragstart", "dragover", "drop", "dragend"] as const) {
      expect(withOnRootDrop[type] ?? 0).toBe((baseline[type] ?? 0) + 1);
    }
  });
});

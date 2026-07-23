/**
 * LeafPane + real EditorPane + real MarkdownEditor integration test
 * (260718-n6a Task 5 — investigation + fail-before/pass-after regression).
 *
 * Unlike LeafPane.test.tsx (mocked EditorPane) and EditorPane.test.tsx
 * (mocked MarkdownEditor), this file mounts the REAL stack — LeafPane ->
 * EditorPane -> MarkdownEditor -> a genuine CM6 EditorView — so it is the
 * only unit-level suite that can observe actual `.cm-jasper-search-match`
 * decorations painted by jasperSearchHighlight. This is the faithful
 * reproduction environment for the "highlights persist after Find-bar
 * dismiss" bug: MarkdownEditor.test.tsx already proves clearSearch() clears
 * decorations when called DIRECTLY on the ref in isolation, so if this
 * suite reproduces the bug, the root cause lives in LeafPane's
 * orchestration layer (activeHandle resolution / close routing), not in
 * MarkdownEditor's clearSearch() itself.
 *
 * Mocking strategy mirrors EditorPane.test.tsx (notesApi + treeApi are the
 * only network seams) — MarkdownEditor is deliberately LEFT UNMOCKED.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/notesApi", () => ({
  ScratchpadUUID: "00000000-0000-4000-a000-000000000001",
  getNote: vi.fn(),
  updateNote: vi.fn(),
}));

vi.mock("../lib/treeApi", () => ({
  postNoteMove: vi.fn(),
  getTree: vi.fn(),
}));

import { ScratchpadUUID, getNote } from "../lib/notesApi";
import { getTree } from "../lib/treeApi";
import { __testing__ as fileTreeTesting } from "../lib/useFileTree";
import { __resetAllControllersForTest } from "../lib/noteBufferController";
import { useTreeStore } from "../lib/useTreeStore";
import { ToastProvider } from "./Toast";
import { TooltipProvider } from "./Tooltip";
import { LeafPane } from "./LeafPane";
import type { LeafNode } from "../lib/paneTree";
import type { Tab } from "../lib/useTabStore";

const getNoteMock = vi.mocked(getNote);
const getTreeMock = vi.mocked(getTree);

type GetTreeReturn = Awaited<ReturnType<typeof getTree>>;
type GetReturn = Awaited<ReturnType<typeof getNote>>;

function okTree(notePath: string): GetTreeReturn {
  return {
    data: {
      root: [
        {
          kind: "note",
          id: ScratchpadUUID,
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

const tabA: Tab = { id: "tab-a", noteId: ScratchpadUUID };
const oneTabLeaf: LeafNode = { t: "leaf", id: "leaf-a", tabs: [tabA], active: "tab-a" };

function renderLeaf() {
  return render(
    <ToastProvider>
      <TooltipProvider>
        <LeafPane
          leaf={oneTabLeaf}
          isActive={true}
          reindexing={false}
          deletedTabIds={new Set()}
          titleForTab={() => "scratchpad"}
          onRequestClose={vi.fn()}
          onCloseOthers={vi.fn()}
          onCloseToRight={vi.fn()}
          onCloseAll={vi.fn()}
          onOpenRight={vi.fn()}
          onTogglePin={vi.fn()}
          onNewTab={vi.fn()}
        />
      </TooltipProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  __resetAllControllersForTest();
  getNoteMock.mockReset();
  getTreeMock.mockReset();
  fileTreeTesting.__resetCoalescer();
  getTreeMock.mockResolvedValue(okTree("scratchpad.md"));
  getNoteMock.mockResolvedValue(okGet("apple banana apple cherry apple"));
  useTreeStore.setState({ connectionStatus: "connected" });
});

afterEach(() => {
  cleanup();
});

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Ctrl+f — jsdom's navigator.platform resolves CM6's "Mod-" to "Ctrl-" (not Meta), confirmed empirically. */
function pressFindShortcut(cmContent: Element) {
  fireEvent.keyDown(cmContent, { key: "f", code: "KeyF", ctrlKey: true });
}

describe("LeafPane + real EditorPane/MarkdownEditor — Find highlight clears on dismiss (260718-n6a Task 5)", () => {
  it("Escape (bar's own keydown) clears .cm-jasper-search-match to zero", async () => {
    const { container } = renderLeaf();
    await flushMicrotasks();

    const cmContent = await waitFor(() => {
      const el = container.querySelector(".cm-content");
      expect(el).not.toBeNull();
      expect(el!.textContent).toContain("apple banana apple cherry apple");
      return el!;
    });

    pressFindShortcut(cmContent);
    const findInput = await screen.findByPlaceholderText("Find");

    fireEvent.change(findInput, { target: { value: "apple" } });
    await waitFor(() => {
      expect(container.querySelectorAll(".cm-jasper-search-match").length).toBe(3);
    });

    const bar = screen.getByTestId("find-bar");
    fireEvent.keyDown(bar, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("find-bar")).not.toBeInTheDocument();
    });
    expect(container.querySelectorAll(".cm-jasper-search-match").length).toBe(0);
  });

  it("the close button clears .cm-jasper-search-match to zero", async () => {
    const { container } = renderLeaf();
    await flushMicrotasks();

    const cmContent = await waitFor(() => {
      const el = container.querySelector(".cm-content");
      expect(el).not.toBeNull();
      expect(el!.textContent).toContain("apple banana apple cherry apple");
      return el!;
    });

    pressFindShortcut(cmContent);
    const findInput = await screen.findByPlaceholderText("Find");

    fireEvent.change(findInput, { target: { value: "apple" } });
    await waitFor(() => {
      expect(container.querySelectorAll(".cm-jasper-search-match").length).toBe(3);
    });

    fireEvent.click(screen.getByLabelText("Close find bar"));

    await waitFor(() => {
      expect(screen.queryByTestId("find-bar")).not.toBeInTheDocument();
    });
    expect(container.querySelectorAll(".cm-jasper-search-match").length).toBe(0);
  });

  it("Escape while focus is in the EDITOR BODY (not the bar's own input) still closes the bar and clears the highlight (root cause: the bar's onKeyDown only fires when focus is inside ITS OWN subtree — a very natural interaction is to click into the editor to inspect a match before dismissing)", async () => {
    const { container } = renderLeaf();
    await flushMicrotasks();

    const cmContent = await waitFor(() => {
      const el = container.querySelector(".cm-content");
      expect(el).not.toBeNull();
      expect(el!.textContent).toContain("apple banana apple cherry apple");
      return el!;
    });

    pressFindShortcut(cmContent);
    const findInput = await screen.findByPlaceholderText("Find");
    fireEvent.change(findInput, { target: { value: "apple" } });
    await waitFor(() => {
      expect(container.querySelectorAll(".cm-jasper-search-match").length).toBe(3);
    });

    // Click into the editor body — a realistic thing to do while using Find
    // (e.g. to inspect a match in context) — moving DOM focus OUT of the
    // find bar's own input/container before pressing Escape.
    fireEvent.click(cmContent);
    fireEvent.keyDown(cmContent, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("find-bar")).not.toBeInTheDocument();
    });
    expect(container.querySelectorAll(".cm-jasper-search-match").length).toBe(0);
  });

  it("emptying the input still clears the highlight (no regression)", async () => {
    const { container } = renderLeaf();
    await flushMicrotasks();

    const cmContent = await waitFor(() => {
      const el = container.querySelector(".cm-content");
      expect(el).not.toBeNull();
      expect(el!.textContent).toContain("apple banana apple cherry apple");
      return el!;
    });

    pressFindShortcut(cmContent);
    const findInput = await screen.findByPlaceholderText("Find");

    fireEvent.change(findInput, { target: { value: "apple" } });
    await waitFor(() => {
      expect(container.querySelectorAll(".cm-jasper-search-match").length).toBe(3);
    });

    fireEvent.change(findInput, { target: { value: "" } });
    await waitFor(() => {
      expect(container.querySelectorAll(".cm-jasper-search-match").length).toBe(0);
    });
  });
});

/**
 * The IME gate is verified by code presence only — jsdom does not dispatch
 * compositionstart/end natively.
 *
 * Environment is jsdom rather than happy-dom, which CM6 tolerates better.
 */
import { forwardRef, useImperativeHandle, useRef, useState, type ReactElement } from "react";
import { render, act, waitFor } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { SearchQuery } from "@codemirror/search";

import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";
import { ToastProvider } from "./Toast";
import { useTreeStore } from "../lib/useTreeStore";


interface ProbeRef {
  ed(): MarkdownEditorRef | null;
}
const Probe = forwardRef<
  ProbeRef,
  {
    noteId?: string;
    initialDoc?: string;
    onChange: (s: string) => void;
    onH1Change?: (h: string | null) => void;
    onSaveRequested?: () => void;
    onBlur?: () => void;
  }
>(function Probe(
  { noteId = "test-note", initialDoc = "", onChange, onH1Change, onSaveRequested, onBlur },
  probeRef
) {
  const [, setRerenderKey] = useState(0);
  const editorRef = useRef<MarkdownEditorRef>(null);
  useImperativeHandle(probeRef, () => ({ ed: () => editorRef.current }), []);
  return (
    <>
      <button data-testid="rerender" onClick={() => setRerenderKey((k) => k + 1)}>
        rerender
      </button>
      <MarkdownEditor
        ref={editorRef}
        noteId={noteId}
        initialDoc={initialDoc}
        onChange={onChange}
        onH1Change={onH1Change}
        onSaveRequested={onSaveRequested}
        onBlur={onBlur}
      />
    </>
  );
});


function renderWithToast(ui: ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe("<MarkdownEditor />", () => {
  it("getContent returns the initialDoc on mount", () => {
    const probeRef = { current: null as ProbeRef | null };
    renderWithToast(<Probe ref={probeRef} initialDoc="hello world" onChange={vi.fn()} />);
    expect(probeRef.current?.ed()?.getContent()).toBe("hello world");
  });

  it("setContent updates the document and getContent reflects it", () => {
    const probeRef = { current: null as ProbeRef | null };
    const onChange = vi.fn();
    renderWithToast(<Probe ref={probeRef} initialDoc="" onChange={onChange} />);
    act(() => {
      probeRef.current?.ed()?.setContent("new content");
    });
    expect(probeRef.current?.ed()?.getContent()).toBe("new content");
  });

  it("setContent triggers onChange (user-typed semantics)", () => {
    const probeRef = { current: null as ProbeRef | null };
    const onChange = vi.fn();
    renderWithToast(<Probe ref={probeRef} initialDoc="" onChange={onChange} />);
    act(() => {
      probeRef.current?.ed()?.setContent("typed");
    });
    expect(onChange).toHaveBeenCalledWith("typed");
  });

  it("applyServerUpdate updates the document but does NOT trigger onChange", () => {
    const probeRef = { current: null as ProbeRef | null };
    const onChange = vi.fn();
    renderWithToast(<Probe ref={probeRef} initialDoc="" onChange={onChange} />);
    act(() => {
      probeRef.current?.ed()?.applyServerUpdate("from-server");
    });
    expect(probeRef.current?.ed()?.getContent()).toBe("from-server");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("EDIT-01: parent re-render does NOT re-instantiate the editor (cursor stability)", () => {
    const probeRef = { current: null as ProbeRef | null };
    const onChange = vi.fn();
    const { getByTestId } = renderWithToast(
      <Probe ref={probeRef} initialDoc="seed" onChange={onChange} />
    );

    act(() => {
      probeRef.current?.ed()?.setContent("after-set");
    });
    expect(probeRef.current?.ed()?.getContent()).toBe("after-set");

    act(() => {
      getByTestId("rerender").click();
    });

    expect(probeRef.current?.ed()?.getContent()).toBe("after-set");
  });

  it("focus() is callable without throwing", () => {
    const probeRef = { current: null as ProbeRef | null };
    renderWithToast(<Probe ref={probeRef} initialDoc="" onChange={vi.fn()} />);
    expect(() => probeRef.current?.ed()?.focus()).not.toThrow();
  });

  it("renders with data-testid='markdown-editor' for E2E selection", () => {
    const { container } = renderWithToast(<Probe initialDoc="" onChange={vi.fn()} />);
    expect(container.querySelector('[data-testid="markdown-editor"]')).not.toBeNull();
  });

  it("onH1Change fires when document contains an H1", () => {
    const probeRef = { current: null as ProbeRef | null };
    const onChange = vi.fn();
    const onH1Change = vi.fn();
    renderWithToast(
      <Probe
        ref={probeRef}
        initialDoc=""
        onChange={onChange}
        onH1Change={onH1Change}
      />
    );
    act(() => {
      probeRef.current?.ed()?.setContent("# My Title\n\nbody");
    });
    expect(onH1Change).toHaveBeenLastCalledWith("My Title");
  });

  it("onH1Change fires with null when document has no H1", () => {
    const probeRef = { current: null as ProbeRef | null };
    const onChange = vi.fn();
    const onH1Change = vi.fn();
    renderWithToast(
      <Probe
        ref={probeRef}
        initialDoc=""
        onChange={onChange}
        onH1Change={onH1Change}
      />
    );
    act(() => {
      probeRef.current?.ed()?.setContent("plain text only");
    });
    expect(onH1Change).toHaveBeenLastCalledWith(null);
  });

  it("focusEnd ref method moves caret to end-of-doc and focuses contentDOM", () => {
    const probeRef = { current: null as ProbeRef | null };
    const { container } = renderWithToast(
      <Probe ref={probeRef} initialDoc="hello world" onChange={vi.fn()} />,
    );
    const contentDOM = container.querySelector(".cm-content") as HTMLElement;
    expect(contentDOM).not.toBeNull();

    act(() => {
      probeRef.current?.ed()?.focusEnd();
    });

    const view = EditorView.findFromDOM(contentDOM);
    expect(view).not.toBeNull();
    const docLen = view!.state.doc.length;
    expect(view!.state.selection.main.from).toBe(docLen);
    expect(view!.state.selection.main.to).toBe(docLen);
    expect(document.activeElement).toBe(view!.contentDOM);
  });

  it("onBlur fires when CM6 contentDOM blurs", () => {
    const onBlur = vi.fn();
    const { container } = renderWithToast(
      <Probe initialDoc="hello" onChange={vi.fn()} onBlur={onBlur} />,
    );
    const contentDOM = container.querySelector(".cm-content") as HTMLElement;
    expect(contentDOM).not.toBeNull();
    act(() => {
      contentDOM.dispatchEvent(new FocusEvent("blur"));
    });
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("onBlur is undefined-safe", () => {
    const { container } = renderWithToast(
      <Probe initialDoc="hello" onChange={vi.fn()} />,
    );
    const contentDOM = container.querySelector(".cm-content") as HTMLElement;
    expect(contentDOM).not.toBeNull();
    expect(() => {
      act(() => {
        contentDOM.dispatchEvent(new FocusEvent("blur"));
      });
    }).not.toThrow();
  });

  it("extensions array includes EditorView.lineWrapping (white-space: pre-wrap on .cm-content)", () => {
    const { container } = renderWithToast(
      <Probe initialDoc="just enough text" onChange={vi.fn()} />,
    );
    const contentDOM = container.querySelector(".cm-content") as HTMLElement;
    expect(contentDOM).not.toBeNull();
    const ws = window.getComputedStyle(contentDOM).whiteSpace;
    expect(["pre-wrap", "break-spaces"]).toContain(ws);
  });

  describe("shared-doc registry sync (WS-10)", () => {
    it("a change dispatched in one view mirrors into another view sharing the same noteId, without re-invoking the receiving view's onChange", () => {
      const noteId = "shared-note-sync";
      const probeARef = { current: null as ProbeRef | null };
      const probeBRef = { current: null as ProbeRef | null };
      const onChangeA = vi.fn();
      const onChangeB = vi.fn();
      renderWithToast(
        <>
          <Probe ref={probeARef} noteId={noteId} initialDoc="shared" onChange={onChangeA} />
          <Probe ref={probeBRef} noteId={noteId} initialDoc="shared" onChange={onChangeB} />
        </>,
      );

      act(() => {
        probeARef.current?.ed()?.setContent("shared-edited");
      });

      // The typing view's own onChange fires exactly once for its own keystroke.
      expect(onChangeA).toHaveBeenCalledTimes(1);
      expect(onChangeA).toHaveBeenCalledWith("shared-edited");

      // The mirrored view's document is kept in sync...
      expect(probeBRef.current?.ed()?.getContent()).toBe("shared-edited");
      // ...but its onChange must NOT fire for a change mirrored INTO it — one
      // keystroke drives exactly one controller save/rename, never one-per-pane.
      expect(onChangeB).not.toHaveBeenCalled();
    });

    it("onHeadingsChange still fires for a mirrored view (Outline must reflect mirrored edits)", () => {
      const noteId = "shared-note-headings";
      const probeARef = { current: null as ProbeRef | null };
      const onHeadingsChangeB = vi.fn();
      renderWithToast(
        <>
          <Probe ref={probeARef} noteId={noteId} initialDoc="" onChange={vi.fn()} />
          <MarkdownEditor
            noteId={noteId}
            initialDoc=""
            onChange={vi.fn()}
            onHeadingsChange={onHeadingsChangeB}
          />
        </>,
      );
      onHeadingsChangeB.mockClear();

      act(() => {
        probeARef.current?.ed()?.setContent("# New Heading\n\nbody");
      });

      expect(onHeadingsChangeB).toHaveBeenCalled();
    });
  });

  describe("regression: attachment resolution uses THIS pane's own noteId, not the global activeNoteId", () => {
    afterEach(() => {
      useTreeStore.setState({ activeNoteId: null });
    });

    it("renders an attachment image scoped to the pane's noteId even when a DIFFERENT note is globally active", async () => {
      // Simulate a split layout: some OTHER pane is the globally-active one...
      useTreeStore.setState({ activeNoteId: "note-ACTIVE-ELSEWHERE" });

      // ...while THIS pane renders a different, inactive note.
      const { container } = renderWithToast(
        <Probe
          noteId="note-THIS-PANE"
          initialDoc="![alt](attachments/photo.png)"
          onChange={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(
          container.querySelector('[data-testid="attachment-image-loaded"]'),
        ).not.toBeNull();
      });
      const img = container.querySelector(
        '[data-testid="attachment-image-loaded"]',
      ) as HTMLImageElement;

      // Before the fix, the image URL was built from the GLOBAL activeNoteId
      // (whichever pane happened to be active), not this pane's own note —
      // an inactive split pane rendered a broken image / wrong note's
      // attachment until the user clicked to activate it.
      expect(img.src).toContain("note-THIS-PANE");
      expect(img.src).not.toContain("note-ACTIVE-ELSEWHERE");
    });
  });

  describe("search commands (WS-09)", () => {
    it("matchInfo returns {0,0} before any search query is set", () => {
      const probeRef = { current: null as ProbeRef | null };
      renderWithToast(
        <Probe ref={probeRef} noteId="search-note-1" initialDoc="the the the" onChange={vi.fn()} />,
      );
      expect(probeRef.current?.ed()?.matchInfo()).toEqual({ current: 0, total: 0 });
    });

    it("matchInfo({search:'the'}) over 'the the the' returns total 3", () => {
      const probeRef = { current: null as ProbeRef | null };
      renderWithToast(
        <Probe ref={probeRef} noteId="search-note-2" initialDoc="the the the" onChange={vi.fn()} />,
      );
      act(() => {
        probeRef.current?.ed()?.setSearchQuery(new SearchQuery({ search: "the" }));
      });
      expect(probeRef.current?.ed()?.matchInfo().total).toBe(3);
    });

    it("setSearchQuery updates highlight state (cm-jasper-search-match decorations render)", () => {
      const probeRef = { current: null as ProbeRef | null };
      const { container } = renderWithToast(
        <Probe ref={probeRef} noteId="search-note-3" initialDoc="the the the" onChange={vi.fn()} />,
      );
      expect(container.querySelectorAll(".cm-jasper-search-match").length).toBe(0);
      act(() => {
        probeRef.current?.ed()?.setSearchQuery(new SearchQuery({ search: "the" }));
      });
      expect(container.querySelectorAll(".cm-jasper-search-match").length).toBe(3);
    });

    it("clearSearch removes the highlight and resets matchInfo to {0,0}", () => {
      const probeRef = { current: null as ProbeRef | null };
      const { container } = renderWithToast(
        <Probe ref={probeRef} noteId="search-note-4" initialDoc="the the the" onChange={vi.fn()} />,
      );
      act(() => {
        probeRef.current?.ed()?.setSearchQuery(new SearchQuery({ search: "the" }));
      });
      expect(container.querySelectorAll(".cm-jasper-search-match").length).toBe(3);
      act(() => {
        probeRef.current?.ed()?.clearSearch();
      });
      expect(container.querySelectorAll(".cm-jasper-search-match").length).toBe(0);
      expect(probeRef.current?.ed()?.matchInfo()).toEqual({ current: 0, total: 0 });
    });

    it("findNext moves the selection to the next match", () => {
      const probeRef = { current: null as ProbeRef | null };
      renderWithToast(
        <Probe ref={probeRef} noteId="search-note-5" initialDoc="the the the" onChange={vi.fn()} />,
      );
      act(() => {
        probeRef.current?.ed()?.setSearchQuery(new SearchQuery({ search: "the" }));
        probeRef.current?.ed()?.findNext();
      });
      expect(probeRef.current?.ed()?.matchInfo().current).toBe(1);
    });

    it("replaceAll replaces every match", () => {
      const probeRef = { current: null as ProbeRef | null };
      renderWithToast(
        <Probe ref={probeRef} noteId="search-note-6" initialDoc="the the the" onChange={vi.fn()} />,
      );
      act(() => {
        probeRef.current?.ed()?.setSearchQuery(
          new SearchQuery({ search: "the", replace: "a" }),
        );
        probeRef.current?.ed()?.replaceAll();
      });
      expect(probeRef.current?.ed()?.getContent()).toBe("a a a");
    });
  });
});

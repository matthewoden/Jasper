/**
 * MarkdownEditor tests.
 *
 * Coverage: EDIT-01 cursor stability (parent re-render does not re-instantiate
 * the editor); ref API (setContent/getContent round-trip; applyServerUpdate does
 * NOT trigger onChange); focus(); IME gate (verified by code presence — jsdom
 * does not dispatch compositionstart/end natively).
 *
 * Test environment: jsdom (better CM6 compatibility than happy-dom).
 */
import { forwardRef, useImperativeHandle, useRef, useState, type ReactElement } from "react";
import { render, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { EditorView } from "@codemirror/view";

import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";
import { ToastProvider } from "./Toast";


interface ProbeRef {
  ed(): MarkdownEditorRef | null;
}
const Probe = forwardRef<
  ProbeRef,
  {
    initialDoc?: string;
    onChange: (s: string) => void;
    onH1Change?: (h: string | null) => void;
    onSaveRequested?: () => void;
    onBlur?: () => void;
  }
>(function Probe(
  { initialDoc = "", onChange, onH1Change, onSaveRequested, onBlur },
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

  it("applyServerUpdate updates the document but does NOT trigger onChange (D-10)", () => {
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

  it("renders with data-testid='markdown-editor' for E2E selection (Plan 05-12)", () => {
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

  it("onBlur fires when CM6 contentDOM blurs (UX-07)", () => {
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

  it("onBlur is undefined-safe (UX-07)", () => {
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
});

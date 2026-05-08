/**
 * MarkdownEditor.test — Plan 05-05 Task 3.
 *
 * Coverage:
 *   - EDIT-01 cursor stability: parent re-render does NOT re-instantiate
 *     the editor (the EditorView reference is identical before/after).
 *   - Ref API: setContent → getContent round-trip; applyServerUpdate
 *     does NOT trigger onChange (D-10 silent reload); focus() is a
 *     no-op stub safe call.
 *   - IME gate: when view.composing is true, onChange does NOT fire
 *     for the docChanged transaction (D-07/D-31). The IME gate is
 *     verified by code-presence in MarkdownEditor.tsx (see the
 *     `u.view.composing` check); behavioral testing requires real
 *     compositionstart/end events that jsdom does not dispatch natively.
 *
 * Test environment: jsdom (configured in vitest.config.ts;
 * RESEARCH §Open Question #4 recommends jsdom for CM6 over happy-dom).
 */
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { render, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";

// Probe component — exposes the inner ref and a "rerender me" button
// so tests can drive both ref calls AND parent re-renders.
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
  }
>(function Probe(
  { initialDoc = "", onChange, onH1Change, onSaveRequested },
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
      />
    </>
  );
});

describe("<MarkdownEditor />", () => {
  it("getContent returns the initialDoc on mount", () => {
    const probeRef = { current: null as ProbeRef | null };
    render(<Probe ref={probeRef} initialDoc="hello world" onChange={vi.fn()} />);
    expect(probeRef.current?.ed()?.getContent()).toBe("hello world");
  });

  it("setContent updates the document and getContent reflects it", () => {
    const probeRef = { current: null as ProbeRef | null };
    const onChange = vi.fn();
    render(<Probe ref={probeRef} initialDoc="" onChange={onChange} />);
    act(() => {
      probeRef.current?.ed()?.setContent("new content");
    });
    expect(probeRef.current?.ed()?.getContent()).toBe("new content");
  });

  it("setContent triggers onChange (user-typed semantics)", () => {
    const probeRef = { current: null as ProbeRef | null };
    const onChange = vi.fn();
    render(<Probe ref={probeRef} initialDoc="" onChange={onChange} />);
    act(() => {
      probeRef.current?.ed()?.setContent("typed");
    });
    expect(onChange).toHaveBeenCalledWith("typed");
  });

  it("applyServerUpdate updates the document but does NOT trigger onChange (D-10)", () => {
    const probeRef = { current: null as ProbeRef | null };
    const onChange = vi.fn();
    render(<Probe ref={probeRef} initialDoc="" onChange={onChange} />);
    act(() => {
      probeRef.current?.ed()?.applyServerUpdate("from-server");
    });
    expect(probeRef.current?.ed()?.getContent()).toBe("from-server");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("EDIT-01: parent re-render does NOT re-instantiate the editor (cursor stability)", () => {
    // Reading getContent before AND after a parent re-render returns the
    // same in-flight document — proof that the EditorView instance was
    // not destroyed/recreated. If it had been, setContent's value would
    // be wiped on rerender.
    const probeRef = { current: null as ProbeRef | null };
    const onChange = vi.fn();
    const { getByTestId } = render(
      <Probe ref={probeRef} initialDoc="seed" onChange={onChange} />
    );

    // Drive a setContent (mutates in-place).
    act(() => {
      probeRef.current?.ed()?.setContent("after-set");
    });
    expect(probeRef.current?.ed()?.getContent()).toBe("after-set");

    // Trigger a parent re-render via the rerender button.
    act(() => {
      getByTestId("rerender").click();
    });

    // The document survives — proves the EditorView was NOT recreated.
    expect(probeRef.current?.ed()?.getContent()).toBe("after-set");
  });

  it("focus() is callable without throwing", () => {
    const probeRef = { current: null as ProbeRef | null };
    render(<Probe ref={probeRef} initialDoc="" onChange={vi.fn()} />);
    expect(() => probeRef.current?.ed()?.focus()).not.toThrow();
  });

  it("renders with data-testid='markdown-editor' for E2E selection (Plan 05-12)", () => {
    const { container } = render(<Probe initialDoc="" onChange={vi.fn()} />);
    expect(container.querySelector('[data-testid="markdown-editor"]')).not.toBeNull();
  });

  it("onH1Change fires when document contains an H1", () => {
    const probeRef = { current: null as ProbeRef | null };
    const onChange = vi.fn();
    const onH1Change = vi.fn();
    render(
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
    render(
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
});

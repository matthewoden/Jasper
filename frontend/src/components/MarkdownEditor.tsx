/**
 * MarkdownEditor — CM6 lifecycle owner. Phase 5 D-26..D-29.
 *
 * Container/presenter split:
 *   EditorPane (container)  → owns banners, conflict prompts, deletion
 *                              banner, autosave + saveStateMachine,
 *                              h1Extract pipeline, editorHandlersRef,
 *                              userHasEdited ref, lastNotePath, WS
 *                              handler refs. Phase 4 wiring is intact
 *                              (D-27).
 *   MarkdownEditor (presenter) → owns the EditorView instance, all CM6
 *                                 extensions, the small ref API. Plan
 *                                 05-11 swaps EditorPane's <textarea>
 *                                 for <MarkdownEditor> in a 1:1 read-
 *                                 site mapping.
 *
 * EDIT-01 cursor stability: EditorView is mounted ONCE on mount via
 * useEffect with []. Never destroys/recreates on prop change. Updates
 * flow via view.dispatch from the ref API or via the silent-reload
 * annotation from EditorPane's WS handler.
 *
 * D-32 Save-state preservation: `onChange` fires on user-typed
 * docChanged transactions only — IME composing transactions and
 * server-update annotations are filtered. EditorPane's onChange
 * callback dispatches userTyped to saveStateMachine the same way the
 * <textarea>'s onChange did. The 2s debounce, Cmd+S, and Phase 4
 * `paused` gating all flow through unchanged.
 *
 * D-26 Ref API contract — EditorPane's call sites swap 1:1:
 *   editorRef.current.getContent()    ← textareaRef.current.value
 *   editorRef.current.setContent(s)   ← textareaRef.current.value = s
 *   editorRef.current.applyServerUpdate(s) ← Phase 4 silent reload
 *   editorRef.current.focus()         ← textareaRef.current.focus()
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Annotation } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";

import { jasperEditorTheme, jasperSyntaxHighlighting } from "../editor/themeBridge";
import { livePreviewPlugin } from "../editor/livePreviewPlugin";
import { frontmatterPlugin } from "../editor/frontmatterPlugin";

/**
 * MarkdownEditorRef — the ref API EditorPane consumes (D-26 LOCKED).
 */
export interface MarkdownEditorRef {
  /** Replace the entire document. Triggers onChange (user-driven). */
  setContent(s: string): void;
  /** Read the current document text. Equivalent to textarea.value. */
  getContent(): string;
  /**
   * Replace the entire document AS A SERVER UPDATE — annotated so the
   * onChange callback can recognize and skip the userTyped dispatch
   * (Phase 4 D-10 silent reload).
   */
  applyServerUpdate(s: string): void;
  /** Focus the editor caret. */
  focus(): void;
}

/**
 * ServerUpdateAnnotation — transactions carrying this annotation are
 * server-driven and MUST NOT trigger onChange in EditorPane (avoids
 * autosave loop on WS reload). Exported for future tests.
 */
export const ServerUpdateAnnotation = Annotation.define<true>();

interface Props {
  /** Initial document text. CAPTURED ONCE; subsequent prop changes
   *  do NOT re-instantiate the editor. Use the ref API for updates. */
  initialDoc: string;
  /** Fires after every user-typed docChanged transaction. NOT fired
   *  during IME composition, NOT fired for server-update annotations. */
  onChange: (doc: string) => void;
  /** Fires when the first H1 line of the doc changes. Plan 05-06+ may
   *  wire this; Plan 05-05 ships the callback shape so EditorPane can
   *  pass through its existing h1Extract pipeline (Phase 3 R2). */
  onH1Change?: (h1: string | null) => void;
  /** Cmd+S handler. Plan 05-10 wires the keymap; Plan 05-05 reserves
   *  the prop so EditorPane's performSave call site is unchanged. */
  onSaveRequested?: () => void;
}

export const MarkdownEditor = forwardRef<MarkdownEditorRef, Props>(
  function MarkdownEditor(
    { initialDoc, onChange, onH1Change, onSaveRequested },
    ref
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);

    // cbRef pattern — RESEARCH §Pattern 1 (line 426-428). The
    // EditorView's updateListener captures its closure ONCE on mount;
    // refreshing the cbRef on every render keeps callbacks current
    // without rebuilding the editor.
    const cbRef = useRef({ onChange, onH1Change, onSaveRequested });
    cbRef.current = { onChange, onH1Change, onSaveRequested };

    useEffect(() => {
      if (!hostRef.current) return;

      const view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: initialDoc,
          extensions: [
            history(),
            search({ top: true }), // EDIT-11 panel — Plan 05-11 binds Cmd+F
            yamlFrontmatter({ content: markdown() }),
            jasperEditorTheme,
            jasperSyntaxHighlighting,
            frontmatterPlugin,
            livePreviewPlugin,
            keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
            EditorView.updateListener.of((u) => {
              if (!u.docChanged) return;
              if (u.view.composing) return; // D-07/D-31 IME gate
              // Skip onChange for server-driven reloads — D-10.
              for (const tr of u.transactions) {
                if (tr.annotation(ServerUpdateAnnotation)) return;
              }
              const doc = u.state.doc.toString();
              cbRef.current.onChange(doc);
              if (cbRef.current.onH1Change) {
                const m = doc.match(/^# (.+)$/m);
                cbRef.current.onH1Change(m ? m[1].trim() : null);
              }
            }),
          ],
        }),
      });
      viewRef.current = view;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // initialDoc captured ONCE — Phase 5 D-26 / EDIT-01 cursor
      // stability. Subsequent updates flow through the ref API.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        setContent(s: string) {
          const v = viewRef.current;
          if (!v) return;
          v.dispatch({
            changes: { from: 0, to: v.state.doc.length, insert: s },
          });
        },
        getContent(): string {
          return viewRef.current?.state.doc.toString() ?? "";
        },
        applyServerUpdate(s: string) {
          const v = viewRef.current;
          if (!v) return;
          v.dispatch({
            changes: { from: 0, to: v.state.doc.length, insert: s },
            annotations: ServerUpdateAnnotation.of(true),
          });
        },
        focus() {
          viewRef.current?.focus();
        },
      }),
      []
    );

    return <div ref={hostRef} className="cm-host" data-testid="markdown-editor" />;
  }
);

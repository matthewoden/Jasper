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
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Annotation } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { autocompletion } from "@codemirror/autocomplete";
import { search } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";

import { jasperEditorTheme, jasperSyntaxHighlighting } from "../editor/themeBridge";
import { livePreviewPlugin } from "../editor/livePreviewPlugin";
import {
  linkClickHandler,
  setWikilinkHandlerCallbacks,
} from "../editor/linkClickHandler";
import { codeblockExpand } from "../editor/codeblockExpand";


import {
  frontmatterHideExtension,
  frontmatterToggleKeymap,
} from "../editor/frontmatterHidePlugin";
import { wikilinkPlugin, resolvedTitlesChanged } from "../editor/wikilinkPlugin";
import { codeLanguages } from "../editor/codeLanguages";
import { externalImagePlugin } from "../editor/externalImagePlugin";
import { imageAttachmentPlugin } from "../editor/imageAttachmentWidget";
import { fileChipPlugin } from "../editor/fileChipWidget";
import { dropPosField, dropIndicatorPlugin } from "../editor/dropIndicatorWidget";
import {
  CheckboxToggleAnnotation,
  checkboxTransactionExtender,
  taskCheckboxPlugin,
} from "../editor/taskCheckboxPlugin";
import { useAttachmentUpload } from "../lib/useAttachmentUpload";
import { saveKeymap, jasperKeymap } from "../editor/jasperKeymap";
import {
  tagClickPlugin,
  setTagClickHandler,
} from "../editor/tagClickPlugin";
import {
  useResolvedTitleSet,
  setResolvedTitlesSnapshot,
} from "../editor/wikilinkResolver";
import {
  wikilinkCompletionSource,
  setWikilinkAutocompleteCallbacks,
} from "../editor/wikilinkAutocomplete";
import {
  tagCompletionSource,
  setTagSnapshot,
} from "../editor/tagAutocomplete";
import { inlineTagPlugin } from "../editor/inlineTagPlugin";
import {
  inlineTagCompletionSource,
  setInlineTagSnapshot,
} from "../editor/inlineTagAutocomplete";
import { useTagBrowser } from "../lib/useTagBrowser";
import { useTreeStore } from "../lib/useTreeStore";
import { useFileTree } from "../lib/useFileTree";
import { postNotes } from "../lib/treeApi";
import type { TreeNode } from "../lib/treeApi";

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
  /**
   * Phase 5.5 / UX-10: focusEnd — focus the editor AND move caret to
   * end-of-doc in a single dispatch. Used by EditorPane's
   * click-anywhere-to-type host wrapper.
   */
  focusEnd(): void;
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
  /** Phase 5.5 / UX-07: fires when CM6's contenteditable surface loses
   *  focus to ANY element outside the editor. Distinct from React's
   *  onBlur (which fires for focus moves WITHIN the editor too). Wired
   *  via EditorView.domEventHandlers({ blur }) in the extensions array. */
  onBlur?: () => void;
}

/**
 * Walk the tree to find the folder path of a given note id.
 * Returns the parent folder path (the directory part of note.path),
 * or "" (vault root) if the note is at the top level or not found.
 */
function getNoteFolder(noteId: string | null, root: TreeNode[]): string {
  if (!noteId) return "";
  const visit = (node: TreeNode): string | null => {
    if (node.kind === "note") {
      if (node.id === noteId) {
        const parts = node.path.split("/");
        parts.pop();
        return parts.join("/");
      }
      return null;
    }
    if (node.kind === "folder" && node.children) {
      for (const child of node.children) {
        const hit = visit(child);
        if (hit !== null) return hit;
      }
    }
    return null;
  };
  for (const node of root) {
    const hit = visit(node);
    if (hit !== null) return hit;
  }
  return "";
}

export const MarkdownEditor = forwardRef<MarkdownEditorRef, Props>(
  function MarkdownEditor(
    { initialDoc, onChange, onH1Change, onSaveRequested, onBlur },
    ref
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);

    const cbRef = useRef({ onChange, onH1Change, onSaveRequested, onBlur });
    cbRef.current = { onChange, onH1Change, onSaveRequested, onBlur };

    const { titleSet, idMap } = useResolvedTitleSet();
    useEffect(() => {
      setResolvedTitlesSnapshot(titleSet, idMap);
      const v = viewRef.current;
      if (v) {
        v.dispatch({ effects: resolvedTitlesChanged.of(undefined) });
      }
    }, [titleSet, idMap]);

    const activeNoteId = useTreeStore((s) => s.activeNoteId);
    const setActiveNote = useTreeStore((s) => s.setActiveNote);
    const setActiveTagFilter = useTreeStore((s) => s.setActiveTagFilter);
    const setTagBrowserExpanded = useTreeStore((s) => s.setTagBrowserExpanded);
    const { tree } = useFileTree();

    const { tags: allTags } = useTagBrowser();

    const noteIdRef = useRef<string | null>(activeNoteId);
    noteIdRef.current = activeNoteId;

    const wikilinkCbRef = useRef({ activeNoteId, setActiveNote, tree });
    wikilinkCbRef.current = { activeNoteId, setActiveNote, tree };

    useEffect(() => {
      setWikilinkHandlerCallbacks({
        setActiveNoteId: (id: string) => {
          wikilinkCbRef.current.setActiveNote(id);
        },
        getCurrentSourceFolder: () => {
          const { activeNoteId: noteId, tree: t } = wikilinkCbRef.current;
          return getNoteFolder(noteId, t?.root ?? []);
        },
      });
      // Called once — the callbacks read fresh state from wikilinkCbRef.current.
    }, []);

    useEffect(() => {
      setWikilinkAutocompleteCallbacks({
        createNoteAndNavigate: async (rawTitle: string, sourceFolder: string) => {
          const { data, error } = await postNotes({
            parent_path: sourceFolder,
            title: rawTitle,
          });
          if (error || !data) {
            throw new Error(
              (error as { message?: string } | undefined)?.message ??
                "createNoteAndNavigate: unknown error",
            );
          }
          wikilinkCbRef.current.setActiveNote(data.id);
        },
        getCurrentSourceFolder: () => {
          const { activeNoteId: noteId, tree: t } = wikilinkCbRef.current;
          return getNoteFolder(noteId, t?.root ?? []);
        },
      });
      // Called once — callbacks read fresh state from wikilinkCbRef.current.
    }, []);

    useEffect(() => {
      setTagSnapshot(allTags ?? []);
      setInlineTagSnapshot(allTags ?? []);
    }, [allTags]);

    useEffect(() => {
      setTagClickHandler((tag: string) => {
        setActiveTagFilter(tag);
        setTagBrowserExpanded(true);
      });
      // Called once — setActiveTagFilter and setTagBrowserExpanded are stable
      // Zustand setters (reference-stable between renders).
    }, [setActiveTagFilter, setTagBrowserExpanded]);

    const [dropActive, setDropActive] = useState(false);
    const { dragHandlers, pasteHandler, isDropTargetActive } = useAttachmentUpload(
      activeNoteId
    );
    useEffect(() => {
      setDropActive(isDropTargetActive);
    }, [isDropTargetActive]);

    useEffect(() => {
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.metaKey || e.ctrlKey) {
          viewRef.current?.dom.setAttribute("data-cmd-held", "true");
        }
      };
      const onKeyUp = (e: KeyboardEvent) => {
        if (!e.metaKey && !e.ctrlKey) {
          viewRef.current?.dom.removeAttribute("data-cmd-held");
        }
      };
      document.addEventListener("keydown", onKeyDown);
      document.addEventListener("keyup", onKeyUp);
      return () => {
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("keyup", onKeyUp);
      };
    }, []);

    useEffect(() => {
      if (!hostRef.current) return;

      const view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: initialDoc,
          extensions: [
            history(),
            search({ top: true }), // Plan 07-27: searchKeymap removed; browser native Cmd+F fires instead
            yamlFrontmatter({ content: markdown({ codeLanguages, base: markdownLanguage }) }),
            jasperEditorTheme,
            jasperSyntaxHighlighting,
            frontmatterHideExtension, // Phase 6.5 / Plan 06.5-06 / UX-T-04 — hide frontmatter by default
            checkboxTransactionExtender, // Phase 12 / Plan 01 — CHK-01 toggle (no-op shim; char-flip is in taskCheckboxPlugin)
            taskCheckboxPlugin,          // Phase 12 / Plan 01 — CHK-01..04 checkbox decorations + click handler (BEFORE livePreviewPlugin)
            livePreviewPlugin,
            wikilinkPlugin, // Phase 6 / Plan 06-09 — [[Title]] decoration
            tagClickPlugin, // Phase 6 / Plan 06-10 — clickable tag values in frontmatter (D-08)
            inlineTagPlugin, // Phase 6.5 / Plan 06.5-05 / UX-T-02 — body inline #tagname decoration
            linkClickHandler, // 05.5-18 — Cmd/Ctrl-click opens external links in a new tab
            externalImagePlugin, // Plan 05-08 — SECURITY-03 external image gate
            imageAttachmentPlugin(noteIdRef), // renders ![alt](attachments/…) below line
            fileChipPlugin(noteIdRef), // renders [name](attachments/…) chip below line
            dropPosField,         // StateField: current drag position (null = hidden)
            dropIndicatorPlugin,  // ViewPlugin: attaches dragover/dragleave/drop listeners
            autocompletion({ override: [wikilinkCompletionSource, tagCompletionSource, inlineTagCompletionSource] }),
            saveKeymap(() => cbRef.current.onSaveRequested?.()), // Plan 05-11 / EDIT-10 — BEFORE defaultKeymap so Cmd+S takes precedence
            frontmatterToggleKeymap, // Phase 6.5 / Plan 06.5-06 / UX-T-04 — Cmd-Shift-Y toggles raw frontmatter view
            codeblockExpand,
            keymap.of([...jasperKeymap, ...defaultKeymap, ...historyKeymap]), // Plan 07-24: jasperKeymap FIRST so Mod-b/Mod-i override defaultKeymap's cursorCharLeft/selectParentSyntax; Plan 07-27: searchKeymap removed (browser native Cmd+F)
            EditorView.lineWrapping,
            EditorView.domEventHandlers({
              blur() {
                cbRef.current.onBlur?.();
              },
            }),
            EditorView.updateListener.of((u) => {
              if (!u.docChanged) return;
              if (u.view.composing) return;
              for (const tr of u.transactions) {
                if (tr.annotation(ServerUpdateAnnotation)) return;
              }
              const doc = u.state.doc.toString();
              cbRef.current.onChange(doc);
              if (cbRef.current.onH1Change) {
                const m = doc.match(/^# (.+)$/m);
                cbRef.current.onH1Change(m ? m[1].trim() : null);
              }
              // D-03: immediate flush on checkbox toggle — bypass 2s autosave debounce
              const isToggle = u.transactions.some(
                (tr) => tr.annotation(CheckboxToggleAnnotation),
              );
              if (isToggle) {
                cbRef.current.onSaveRequested?.();
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
        focusEnd() {
          const v = viewRef.current;
          if (!v) return;
          v.focus();
          const docLen = v.state.doc.length;
          v.dispatch({ selection: { anchor: docLen, head: docLen } });
        },
      }),
      []
    );

    return (
      <div
        style={{ flex: 1, minHeight: 0, display: "flex", position: "relative" }}
        className={dropActive ? "cm-drop-target-active" : undefined}
        data-testid="attachment-drop-zone"
        onDragEnter={(e) => dragHandlers.onDragEnter(e.nativeEvent)}
        onDragOver={(e) => dragHandlers.onDragOver(e.nativeEvent)}
        onDragLeave={(e) => dragHandlers.onDragLeave(e.nativeEvent)}
        onDrop={async (e) => {
          const v = viewRef.current;
          if (v) await dragHandlers.onDrop(e.nativeEvent, v);
        }}
        onPaste={async (e) => {
          const v = viewRef.current;
          if (v) await pasteHandler(e.nativeEvent, v);
        }}
      >
        {dropActive && (
          <div className="cm-drop-target-hint" aria-hidden="true">
            Drop to attach
          </div>
        )}
        <div
          ref={hostRef}
          className="cm-host"
          data-testid="markdown-editor"
          role="textbox"
          aria-label="Note content"
          aria-multiline="true"
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
          }}
        />
      </div>
    );
  }
);

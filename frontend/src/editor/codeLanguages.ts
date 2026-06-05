/**
 * codeLanguages — LanguageDescription[] passed to
 * markdown({codeLanguages: [...]}) so code-fence ```lang blocks
 * highlight per declared language. Phase 5 D-03 / EDIT-08.
 *
 * All grammars are EAGERLY imported (PERF-04, SECURITY-07 — no
 * runtime fetch). The `async load()` callback is required by
 * LanguageDescription's API but the imports are captured by closure
 * — no dynamic import happens at runtime; the bundler resolves
 * everything at build time.
 *
 * Bundled set (D-03):
 *   javascript / typescript (lang-javascript handles both via opts)
 *   python
 *   go
 *   sh / bash (legacy-modes shell wrapped in StreamLanguage)
 *   json
 *   yaml
 *   markdown (recursive — but accepted)
 *   html
 *   css
 *
 * Unknown language → no LanguageDescription matches → CM6 falls back
 * to plain monospace. No error, no warning (UI-SPEC §Code-block
 * highlighting line 336).
 *
 * Bundle cost: see 05-BUNDLE-MEASURE.md for the measured production
 * delta. RESEARCH §Bundle Budget revised D-45's 200KB ceiling based
 * on measured evidence; this file's import set is the implementation
 * of that revision.
 */
import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
} from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { markdown } from "@codemirror/lang-markdown";


import { shell } from "@codemirror/legacy-modes/mode/shell";

export const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: "javascript",
    alias: ["js", "jsx"],
    async load() {
      return javascript({ jsx: true });
    },
  }),
  LanguageDescription.of({
    name: "typescript",
    alias: ["ts", "tsx"],
    async load() {
      return javascript({ jsx: true, typescript: true });
    },
  }),
  LanguageDescription.of({
    name: "python",
    alias: ["py"],
    async load() {
      return python();
    },
  }),
  LanguageDescription.of({
    name: "go",
    alias: ["golang"],
    async load() {
      return go();
    },
  }),
  LanguageDescription.of({
    name: "html",
    async load() {
      return html();
    },
  }),
  LanguageDescription.of({
    name: "css",
    async load() {
      return css();
    },
  }),
  LanguageDescription.of({
    name: "json",
    async load() {
      return json();
    },
  }),
  LanguageDescription.of({
    name: "yaml",
    alias: ["yml"],
    async load() {
      return yaml();
    },
  }),
  LanguageDescription.of({
    name: "markdown",
    alias: ["md"],
    async load() {
      return markdown();
    },
  }),
  LanguageDescription.of({
    name: "shell",
    alias: ["sh", "bash"],
    async load() {
      return new LanguageSupport(StreamLanguage.define(shell));
    },
  }),
];

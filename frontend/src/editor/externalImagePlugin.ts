/**
 * externalImagePlugin — Plan 05-08 / SECURITY-03 / D-21..D-25.
 *
 * Replaces inline ![alt](https://...) external images with a click-
 * to-load placeholder widget. After user click, fetch the image bytes,
 * convert to a Blob, create a blob: URL via URL.createObjectURL, and
 * swap the placeholder for <img src="blob:...">. Strict CSP
 * (img-src 'self' data: blob: — Plan 05-04) blocks direct
 * <img src="https://..."> but permits the blob: URL — the widget is
 * the bridge.
 *
 * Allow-list (D-21, D-24, D-43):
 *   - Per-URL granularity (full URL string match), NOT per-host
 *   - Stored as JSON.stringify([...Set<string>]) at
 *     localStorage["jasper:img-allowlist"]
 *   - Survives page reloads; does NOT sync across browsers
 *   - No UI to remove entries in v1 (DevTools / clear localStorage)
 *
 * Internal images (D-23) — bypass the gate. An "internal" URL is:
 *   - Same-origin (hostname matches window.location.hostname)
 *   - Or a relative path NOT starting with http(s)://
 *
 * Memory hygiene (RESEARCH §Pitfall 4): the widget tracks its blob
 * URL on the instance and revokes it in destroy() — every widget
 * destroyed cleans up exactly one URL.createObjectURL allocation.
 *
 * Sibling pattern: this plugin does NOT touch livePreviewPlugin or
 * frontmatterPlugin. The MarkdownEditor extension array imports all
 * three as separate Extensions per D-29 (the integration seam).
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";

export const ALLOWLIST_KEY = "jasper:img-allowlist";


const COPY_ALLOW_BUTTON = "Allow this image";
const copyAllowAria = (host: string): string => `Allow image from ${host}`;
const copyFetchFailed = (host: string): string =>
  `Could not load image from ${host}.`;
const copyAltFallback = (host: string): string => `External image from ${host}`;
const copyDescription = (host: string): string =>
  `External image from ${host}. Click "Allow this image" to load it.`;

/**
 * readAllowlist — returns the persisted Set of URL strings. Returns
 * an empty Set on parse error or quota-exceeded scenarios.
 */
export function readAllowlist(): Set<string> {
  try {
    const raw = localStorage.getItem(ALLOWLIST_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

/**
 * writeAllowlist — persists the Set to localStorage. Silently no-ops
 * on quota / permission errors so the widget remains in-memory-allowed
 * for the session.
 */
export function writeAllowlist(s: Set<string>): void {
  try {
    localStorage.setItem(ALLOWLIST_KEY, JSON.stringify([...s]));
  } catch {
    /* quota exceeded or storage disabled — keep in-memory only */
  }
}

/**
 * isExternalUrl — D-23 routing. Returns true ONLY for absolute URLs
 * with http(s) scheme whose host differs from window.location.hostname.
 * All relative paths, attachments, and same-origin absolute URLs are
 * considered internal and render via CM6's normal Image rendering
 * (no widget injected).
 */
export function isExternalUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    if (u.hostname === window.location.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * ExternalImageWidget — Decoration.replace block widget. Renders the
 * placeholder until allow-listed; on click, fetches the image bytes,
 * creates a blob URL, and renders <img src="blob:...">.
 */
export class ExternalImageWidget extends WidgetType {
  private blobUrl: string | null = null;
  private destroyed = false;

  constructor(
    readonly url: string,
    readonly alt: string
  ) {
    super();
  }

  eq(o: ExternalImageWidget): boolean {
    return this.url === o.url && this.alt === o.alt;
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-external-image";
    container.dataset.url = this.url;
    const allowed = readAllowlist().has(this.url);
    if (allowed) {
      void this.renderLoaded(container);
    } else {
      this.renderPlaceholder(container);
    }
    return container;
  }

  private renderPlaceholder(container: HTMLElement): void {
    container.replaceChildren();
    const host = this.safeHost();
    const path = this.safePath();

    const desc = document.createElement("span");
    desc.className = "cm-img-description sr-only";
    desc.textContent = copyDescription(host);
    desc.style.cssText =
      "position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden";
    container.append(desc);

    const hostEl = document.createElement("div");
    hostEl.className = "cm-img-host";
    hostEl.textContent = host;

    const pathEl = document.createElement("div");
    pathEl.className = "cm-img-path";
    pathEl.textContent = path.length > 48 ? path.slice(0, 48) + "…" : path;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-img-allow-btn";
    button.textContent = COPY_ALLOW_BUTTON;
    button.setAttribute("aria-label", copyAllowAria(host));
    button.setAttribute("data-testid", "external-image-allow-btn");
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const allow = readAllowlist();
      allow.add(this.url);
      writeAllowlist(allow);
      void this.renderLoaded(container);
    });

    container.append(hostEl, pathEl, button);
  }

  private async renderLoaded(container: HTMLElement): Promise<void> {
    container.replaceChildren();
    const host = this.safeHost();
    try {
      const resp = await fetch(this.url, { mode: "cors" });
      if (this.destroyed) return;
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      if (this.destroyed) return;
      this.blobUrl = URL.createObjectURL(blob);
      const img = document.createElement("img");
      img.src = this.blobUrl;
      img.alt = this.alt || copyAltFallback(host);
      img.className = "cm-img-loaded";
      img.setAttribute("data-testid", "external-image-loaded");
      container.append(img);
    } catch {
      const err = document.createElement("div");
      err.className = "cm-img-error";
      err.textContent = copyFetchFailed(host);
      err.setAttribute("data-testid", "external-image-error");
      container.append(err);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  }

  ignoreEvent(): boolean {
    return false;
  }

  private safeHost(): string {
    try {
      return new URL(this.url).hostname;
    } catch {
      return "(invalid URL)";
    }
  }

  private safePath(): string {
    try {
      return new URL(this.url).pathname;
    } catch {
      return "";
    }
  }
}

/**
 * buildImageDecorations — walks lezer-markdown Image nodes; for each
 * external URL, emits Decoration.replace with the widget. Internal
 * URLs are SKIPPED so CM6 renders them via normal flow.
 *
 * Note: CM6 ViewPlugin decorations MUST NOT use `block: true` —
 * "Block decorations may not be specified via plugins" (CM6 constraint).
 * We use a standard inline Decoration.replace widget here; the widget's
 * container div uses CSS `display:block` to visually occupy its own line.
 * This is the correct approach for inline-positioned widgets that expand
 * to fill the line width (UI-SPEC §External-image widget).
 */
export function buildImageDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  const IMAGE_RE = /^!\[(.*?)\]\((.+)\)$/;
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "Image") return;
        const text = view.state.doc.sliceString(node.from, node.to);
        const m = text.match(IMAGE_RE);
        if (!m) return;
        const [, alt, url] = m;
        if (!isExternalUrl(url)) return;
        builder.add(
          node.from,
          node.to,
          Decoration.replace({
            widget: new ExternalImageWidget(url, alt),
            // block: true — PROHIBITED in ViewPlugin decorations (CM6
            // constraint). Visual block appearance is handled via CSS
            // `.cm-external-image { display: block; }`.
          })
        );
      },
    });
  }
  return builder.finish();
}

export const externalImagePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildImageDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.view.composing) {
        this.decorations = this.decorations.map(u.changes);
        return;
      }
      if (
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = buildImageDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

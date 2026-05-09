/**
 * externalImagePlugin.test.ts — vitest suite covering SECURITY-03 / D-21..D-25.
 *
 * Covers:
 *   - isExternalUrl (D-23 internal bypass — 5 cases)
 *   - Allow-list persistence round-trip (D-21, D-43 — 4 cases)
 *   - ExternalImageWidget render paths (placeholder, click, fetch success,
 *     fetch failure, destroy revoke — 6 cases)
 *   - Plugin integration: external emits widget, internal skips (3 cases)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";

import {
  ALLOWLIST_KEY,
  ExternalImageWidget,
  buildImageDecorations,
  externalImagePlugin,
  isExternalUrl,
  readAllowlist,
  writeAllowlist,
} from "./externalImagePlugin";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        yamlFrontmatter({ content: markdown() }),
        externalImagePlugin,
      ],
    }),
  });
}

/** Flush the micro-task queue (one tick). Used after toDOM() to let
 *  async renderLoaded complete so assertions can inspect the DOM. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// describe: isExternalUrl (D-23)
// ---------------------------------------------------------------------------

describe("externalImagePlugin / isExternalUrl (D-23)", () => {
  it("https URL with foreign host is external", () => {
    // Override window.location.hostname for the test environment
    // jsdom sets it to "localhost" by default
    expect(isExternalUrl("https://example.com/image.png")).toBe(true);
  });

  it("same-origin https URL is internal", () => {
    // jsdom hostname = "localhost"
    const sameOrigin = `https://${window.location.hostname}/some/path.png`;
    expect(isExternalUrl(sameOrigin)).toBe(false);
  });

  it("relative path 'attachments/foo.png' is internal", () => {
    expect(isExternalUrl("attachments/foo.png")).toBe(false);
  });

  it("absolute path '/api/v1/attachments/foo.png' is internal (no scheme)", () => {
    expect(isExternalUrl("/api/v1/attachments/foo.png")).toBe(false);
  });

  it("malformed URL string returns false (does not throw)", () => {
    expect(isExternalUrl("https://[invalid")).toBe(false);
    expect(isExternalUrl("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// describe: allow-list persistence (D-21, D-43)
// ---------------------------------------------------------------------------

describe("externalImagePlugin / allow-list persistence (D-21, D-43)", () => {
  beforeEach(() => {
    localStorage.removeItem(ALLOWLIST_KEY);
    vi.restoreAllMocks();
  });

  it("readAllowlist returns empty Set on first read", () => {
    const s = readAllowlist();
    expect(s.size).toBe(0);
  });

  it("writeAllowlist + readAllowlist round-trips a URL", () => {
    const url = "https://example.com/img.png";
    writeAllowlist(new Set([url]));
    const s = readAllowlist();
    expect(s.has(url)).toBe(true);
  });

  it("readAllowlist tolerates malformed JSON (returns empty Set)", () => {
    localStorage.setItem(ALLOWLIST_KEY, "not-valid-json{{");
    const s = readAllowlist();
    expect(s.size).toBe(0);
  });

  it("readAllowlist tolerates non-array JSON", () => {
    localStorage.setItem(ALLOWLIST_KEY, JSON.stringify({ url: "x" }));
    const s = readAllowlist();
    expect(s.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// describe: ExternalImageWidget
// ---------------------------------------------------------------------------

describe("externalImagePlugin / ExternalImageWidget", () => {
  const EXTERNAL_URL = "https://example.com/photo.png";
  const ALT = "a photo";

  beforeEach(() => {
    localStorage.removeItem(ALLOWLIST_KEY);
    vi.restoreAllMocks();
    // jsdom does not implement URL.createObjectURL / revokeObjectURL.
    // Assign stubs so vi.spyOn can wrap them in individual tests.
    if (!URL.createObjectURL) {
      URL.createObjectURL = vi.fn().mockReturnValue("blob:stub");
    }
    if (!URL.revokeObjectURL) {
      URL.revokeObjectURL = vi.fn();
    }
  });

  it("renders placeholder with host + 'Allow this image' button when not allow-listed", () => {
    const widget = new ExternalImageWidget(EXTERNAL_URL, ALT);
    const dom = widget.toDOM();

    // Must show the host label
    const hostEl = dom.querySelector(".cm-img-host");
    expect(hostEl?.textContent).toBe("example.com");

    // Must have the "Allow this image" button with locked copy
    const btn = dom.querySelector<HTMLButtonElement>(
      '[data-testid="external-image-allow-btn"]'
    );
    expect(btn).toBeTruthy();
    expect(btn?.textContent).toBe("Allow this image");
    expect(btn?.getAttribute("aria-label")).toBe("Allow image from example.com");
  });

  it("placeholder is reachable by Tab — button has type='button'", () => {
    const widget = new ExternalImageWidget(EXTERNAL_URL, ALT);
    const dom = widget.toDOM();
    const btn = dom.querySelector<HTMLButtonElement>(
      '[data-testid="external-image-allow-btn"]'
    );
    expect(btn?.type).toBe("button");
  });

  it("clicking 'Allow this image' adds URL to allow-list", async () => {
    // Mock fetch to avoid network call in this test
    const mockBlob = new Blob(["x"], { type: "image/png" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => mockBlob,
      })
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const widget = new ExternalImageWidget(EXTERNAL_URL, ALT);
    const dom = widget.toDOM();

    const btn = dom.querySelector<HTMLButtonElement>(
      '[data-testid="external-image-allow-btn"]'
    );
    btn?.click();

    // Allow-list should now contain the URL
    const saved = readAllowlist();
    expect(saved.has(EXTERNAL_URL)).toBe(true);

    await tick();
  });

  it("fetch success renders <img src='blob:...'> via createObjectURL", async () => {
    // Pre-allow so toDOM() goes straight to renderLoaded
    writeAllowlist(new Set([EXTERNAL_URL]));

    const mockBlob = new Blob(["x"], { type: "image/png" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => mockBlob,
      })
    );
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:fake-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const widget = new ExternalImageWidget(EXTERNAL_URL, ALT);
    const dom = widget.toDOM();

    await tick();

    const img = dom.querySelector<HTMLImageElement>(
      '[data-testid="external-image-loaded"]'
    );
    expect(img).toBeTruthy();
    expect(img?.src).toBe("blob:fake-url");
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
  });

  it("fetch failure renders the locked error copy", async () => {
    writeAllowlist(new Set([EXTERNAL_URL]));

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        blob: async () => new Blob(),
      })
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const widget = new ExternalImageWidget(EXTERNAL_URL, ALT);
    const dom = widget.toDOM();

    await tick();

    const errEl = dom.querySelector('[data-testid="external-image-error"]');
    expect(errEl).toBeTruthy();
    // VERBATIM locked error copy (UI-SPEC §Copywriting Contract)
    expect(errEl?.textContent).toBe("Could not load image from example.com.");
  });

  it("destroy() calls URL.revokeObjectURL on the blob URL it created (Pitfall 4)", async () => {
    writeAllowlist(new Set([EXTERNAL_URL]));

    const mockBlob = new Blob(["x"], { type: "image/png" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => mockBlob,
      })
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake-url");
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});

    const widget = new ExternalImageWidget(EXTERNAL_URL, ALT);
    const dom = widget.toDOM();

    await tick();

    // Verify img is rendered (renderLoaded completed)
    const img = dom.querySelector('[data-testid="external-image-loaded"]');
    expect(img).toBeTruthy();

    // Simulate widget unmount (scrolled away, file navigated)
    widget.destroy();

    // Must revoke the blob URL to prevent memory leak
    expect(revokeSpy).toHaveBeenCalledWith("blob:fake-url");
  });
});

// ---------------------------------------------------------------------------
// describe: plugin integration
// ---------------------------------------------------------------------------

describe("externalImagePlugin / plugin integration", () => {
  const views: EditorView[] = [];

  beforeEach(() => {
    localStorage.removeItem(ALLOWLIST_KEY);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("emits Decoration.replace for an external Image node", () => {
    const doc = "![alt text](https://example.com/image.png)";
    const view = makeView(doc);
    views.push(view);

    // Wait for lezer to parse (sync in test env)
    const decos = buildImageDecorations(view);
    let hasWidget = false;
    const cursor = decos.iter();
    while (cursor.value !== null) {
      const spec = (
        cursor.value as unknown as { spec: { widget?: unknown } }
      ).spec;
      if (spec?.widget) {
        hasWidget = true;
        break;
      }
      cursor.next();
    }
    expect(hasWidget).toBe(true);
  });

  it("does NOT emit a widget for an internal image (D-23)", () => {
    const doc = "![alt text](attachments/photo.png)";
    const view = makeView(doc);
    views.push(view);

    const decos = buildImageDecorations(view);
    let hasWidget = false;
    const cursor = decos.iter();
    while (cursor.value !== null) {
      const spec = (
        cursor.value as unknown as { spec: { widget?: unknown } }
      ).spec;
      if (spec?.widget) {
        hasWidget = true;
        break;
      }
      cursor.next();
    }
    expect(hasWidget).toBe(false);
  });

  it("does NOT emit a widget for a same-origin absolute URL", () => {
    const sameOriginUrl = `https://${window.location.hostname}/api/v1/attachments/foo.png`;
    const doc = `![alt](${sameOriginUrl})`;
    const view = makeView(doc);
    views.push(view);

    const decos = buildImageDecorations(view);
    let hasWidget = false;
    const cursor = decos.iter();
    while (cursor.value !== null) {
      const spec = (
        cursor.value as unknown as { spec: { widget?: unknown } }
      ).spec;
      if (spec?.widget) {
        hasWidget = true;
        break;
      }
      cursor.next();
    }
    expect(hasWidget).toBe(false);
  });
});

/**
 * FilePreviewView tests — Plan 07-32b (UAT-3 R7).
 *
 * Renders an inline <img> for image extensions (png/jpg/jpeg/gif/webp/svg/avif/ico)
 * sourced from `/api/v1/files?path=<encoded>`. Non-image files render a metadata
 * panel with filename, type (uppercased extension), and full path.
 *
 * URL contract: query-parameter style `/api/v1/files?path=<encodedPath>` per
 * Plan 07-32a (the GET endpoint) and the canonical FilePreviewView source in
 * 07-31-INVESTIGATION.md §Item 6 lines 232-237.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FilePreviewView } from "./FilePreviewView";

describe("<FilePreviewView />", () => {
  it("FPV-1: image extension .png renders <img> with src='/api/v1/files?path=<encoded>'", () => {
    const path = "gallery/attachments/photo.png";
    render(<FilePreviewView path={path} />);

    const section = screen.getByTestId("file-preview-view");
    expect(section).toBeInTheDocument();
    expect(section.getAttribute("data-file-preview-kind")).toBe("image");

    const img = section.querySelector("img");
    expect(img).not.toBeNull();
    // Query-parameter URL: forward slashes inside path are %2F-encoded by encodeURIComponent.
    const expected = `/api/v1/files?path=${encodeURIComponent(path)}`;
    expect(img?.getAttribute("src")).toBe(expected);
    // alt should be the basename for accessibility.
    expect(img?.getAttribute("alt")).toBe("photo.png");
  });

  it("FPV-1b: image extension .jpg also renders <img>", () => {
    render(<FilePreviewView path="snap.jpg" />);
    const section = screen.getByTestId("file-preview-view");
    expect(section.getAttribute("data-file-preview-kind")).toBe("image");
    const img = section.querySelector("img");
    expect(img?.getAttribute("src")).toBe(
      `/api/v1/files?path=${encodeURIComponent("snap.jpg")}`,
    );
  });

  it("FPV-2: non-image extension .pdf renders metadata panel with filename + type + path", () => {
    const path = "docs/spec.pdf";
    render(<FilePreviewView path={path} />);

    const section = screen.getByTestId("file-preview-view");
    expect(section.getAttribute("data-file-preview-kind")).toBe("metadata");

    // Metadata: filename "spec.pdf", type "PDF" (uppercased), and the full path.
    expect(screen.getByText(/spec\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/PDF/)).toBeInTheDocument();
    expect(screen.getByText(/docs\/spec\.pdf/)).toBeInTheDocument();

    // No <img> in metadata mode.
    expect(section.querySelector("img")).toBeNull();
  });

  it("FPV-3: SVG renders as image (treated as inline-renderable)", () => {
    render(<FilePreviewView path="icon.svg" />);
    const section = screen.getByTestId("file-preview-view");
    expect(section.getAttribute("data-file-preview-kind")).toBe("image");
    const img = section.querySelector("img");
    expect(img?.getAttribute("src")).toBe(
      `/api/v1/files?path=${encodeURIComponent("icon.svg")}`,
    );
  });

  it("FPV-4: extensionless file falls into metadata branch with FILE type label", () => {
    render(<FilePreviewView path="README" />);
    const section = screen.getByTestId("file-preview-view");
    expect(section.getAttribute("data-file-preview-kind")).toBe("metadata");
    expect(screen.getByText(/README/)).toBeInTheDocument();
    // Type label falls back to FILE when extension is empty.
    expect(screen.getByText(/FILE/)).toBeInTheDocument();
  });

  it("FPV-5: case-insensitive image detection — uppercase .PNG is treated as image", () => {
    render(<FilePreviewView path="UP.PNG" />);
    const section = screen.getByTestId("file-preview-view");
    expect(section.getAttribute("data-file-preview-kind")).toBe("image");
  });

  it("FPV-6: data-file-preview-path attribute echoes the input path", () => {
    const path = "nested/dir/x.webp";
    render(<FilePreviewView path={path} />);
    expect(
      screen.getByTestId("file-preview-view").getAttribute("data-file-preview-path"),
    ).toBe(path);
  });
});

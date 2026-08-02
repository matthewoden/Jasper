/**
 * FilePreviewView — middle-pane preview for non-markdown files.
 *
 * Image extensions render an inline <img> sourced from
 * `/api/v1/files?path=<encoded>` (query-parameter form because OpenAPI 3.1
 * has no native multi-segment path-wildcard and oapi-codegen does not emit
 * chi `*` catch-all routes). Non-image files render a metadata panel.
 *
 * Security: same-origin <img src>; CSP restricts img-src to 'self'. The
 * path attribute echoes the tree row label — no additional information disclosure.
 */
import type { CSSProperties } from "react";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico"];

function getExt(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx + 1).toLowerCase() : "";
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  height: "100%",
  background: "var(--color-bg)",
  overflow: "auto",
};

// Same 760px centered reading column as the note surface
// (themeBridge.ts .cm-content) and the editor-pane-placeholder empty state
// — values must stay identical across all three.
const columnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  maxWidth: 760,
  margin: "0 auto",
  padding: "44px 56px 200px",
  boxSizing: "border-box",
};

const imageStyle: CSSProperties = {
  maxHeight: "100%",
  maxWidth: "100%",
  objectFit: "contain",
};

const metadataStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 24,
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  background: "var(--color-surface)",
  color: "var(--color-fg)",
  fontFamily: "inherit",
  fontSize: 14,
  minWidth: 320,
  maxWidth: "100%",
  wordBreak: "break-all",
};

export interface FilePreviewViewProps {
  path: string;
  style?: CSSProperties;
}

export function FilePreviewView({ path, style }: FilePreviewViewProps): React.JSX.Element {
  const ext = getExt(path);
  const name = basename(path);
  const isImage = IMAGE_EXTS.includes(ext);
  const url = `/api/v1/files?path=${encodeURIComponent(path)}`;
  const typeLabel = ext ? ext.toUpperCase() : "FILE";

  return (
    <section
      data-testid="file-preview-view"
      data-file-preview-path={path}
      data-file-preview-kind={isImage ? "image" : "metadata"}
      style={{ ...containerStyle, ...style }}
    >
      <div style={columnStyle}>
        {isImage ? (
          <img src={url} alt={name} style={imageStyle} />
        ) : (
          <div style={metadataStyle}>
            <div>
              <strong>Filename:</strong> {name}
            </div>
            <div>
              <strong>Type:</strong> {typeLabel}
            </div>
            <div>
              <strong>Location:</strong> {path}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

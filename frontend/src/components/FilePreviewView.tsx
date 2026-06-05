/**
 * FilePreviewView — middle-pane preview for non-markdown files (Plan 07-32b / UAT-3 R7).
 *
 * When useTreeStore.activeFilePath is non-null, EditorPane renders this
 * component instead of the markdown editor. Image extensions render an
 * inline <img> sourced from `/api/v1/files?path=<encoded>` (the
 * query-parameter contract introduced by Plan 07-32a's backend GET
 * /files endpoint). Non-image files render a metadata panel showing the
 * filename, type (uppercased extension), and full path.
 *
 * URL contract: `/api/v1/files?path=${encodeURIComponent(path)}` — matches
 * both Plan 07-32a (GET) and Plan 07-34 (POST) which use a query parameter
 * because OpenAPI 3.1 has no native multi-segment path-wildcard syntax and
 * oapi-codegen does not emit chi `*` catch-all routes. See 07-CONTEXT.md
 * D-53 + 07-31-INVESTIGATION.md §Item 6 lines 226-256.
 *
 * Security:
 *   - Same-origin <img src>; CSP already restricts img-src to 'self'.
 *   - The path attribute on the section element is the same value already
 *     shown in the tree row label — no information disclosure beyond the
 *     existing surface.
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
  padding: 24,
  background: "var(--color-bg)",
  overflow: "auto",
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
    </section>
  );
}

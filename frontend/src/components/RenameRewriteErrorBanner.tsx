/**
 * RenameRewriteErrorBanner — persistent banner shown when a note or tag rename
 * fails to rewrite all vault-wide references and the server rolls back.
 *
 * Client-state-driven (stored in App-level state, not server-state), so it
 * persists until explicitly dismissed. role="alert" for screen-reader announcement.
 */

import { X } from "lucide-react";

export interface RewriteError {
  kind: "rename" | "tag-rewrite";
  /** For kind="tag-rewrite": the tag name that was being renamed/deleted. */
  targetName?: string;
  /** For kind="rename": the number of references that could not be updated. */
  missedCount?: number;
}

interface Props {
  /** null when no error; banner renders nothing. */
  state: RewriteError | null;
  onDismiss: () => void;
}

export function RenameRewriteErrorBanner({ state, onDismiss }: Props) {
  if (!state) return null;

  const title =
    state.kind === "rename" ? "Rename failed" : "Tag rewrite failed";
  const body =
    state.kind === "rename"
      ? `${state.missedCount != null ? String(state.missedCount) : "Some"} references could not be updated. The rename has been rolled back.`
      : `"${state.targetName ?? ""}" could not be updated across all notes. The change has been rolled back.`;

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        background: "color-mix(in srgb, var(--color-destructive, #c0392b) 10%, var(--color-surface, #fff))",
        borderLeft: "4px solid var(--color-destructive, #c0392b)",
        borderBottom: "1px solid var(--color-border)",
        paddingTop: "var(--spacing-md-tight, 8px)",
        paddingBottom: "var(--spacing-md-tight, 8px)",
        paddingLeft: 16,
        paddingRight: 16,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--color-destructive, #c0392b)",
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 14, color: "var(--color-fg)" }}>{body}</div>
      </div>
      <button
        type="button"
        aria-label="Dismiss error"
        onClick={onDismiss}
        style={{
          background: "transparent",
          border: 0,
          color: "var(--color-muted)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 4,
          flexShrink: 0,
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

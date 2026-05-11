/**
 * RenameRewriteErrorBanner — persistent error banner for D-36 / D-37
 * rename-rewrite rollback failures.
 *
 * Plan 06-11 / LINKS-07.
 *
 * Modeled after MigrationBanner (Phase 2 analog): destructive-tinted full-width
 * row, title + body, dismiss X button.
 *
 * Shows when a note rename OR tag rename fails to rewrite all references
 * vault-wide and the server rolls back. The banner persists until dismissed
 * (unlike the migration banner which is server-state-driven, this is
 * client-state-driven: the error is surfaced by the API client wrapper and
 * stored in App-level state).
 *
 * Copy (UI-SPEC Surface 6 — Error Banners):
 *   kind="rename":     title "Rename failed"
 *                      body  "{N} references could not be updated. The rename has been rolled back."
 *   kind="tag-rewrite": title "Tag rewrite failed"
 *                       body  '"{tag}" could not be updated across all notes. The change has been rolled back.'
 *
 * Aria: role="alert" for screen reader announcement on appear.
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

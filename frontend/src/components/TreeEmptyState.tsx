/**
 * Tree empty state — UI-SPEC §Surface 1 §Empty state.
 *
 * Rendered ONLY when tree.root is empty (zero notes AND zero folders).
 * Left-aligned (NOT centered — keeps visual anchor consistent with where
 * rows would appear). 24px (lg) padding-top so the empty state sits below
 * the toolbar with breathing room.
 *
 * The [+] glyph in the body is rendered as the same lucide FilePlus 14px
 * icon used in the toolbar (text-muted) so the user can visually link
 * "the icon they see in the body" to "the icon they see in the toolbar."
 *
 * Locked copy (verbatim):
 *   "No notes yet."
 *   "Press [+] to create your first note."
 */
import { FilePlus } from "lucide-react";

export function TreeEmptyState() {
  return (
    <div
      className="flex flex-col items-start"
      style={{
        padding: "var(--spacing-lg, 24px) var(--spacing-md, 16px)",
        paddingTop: "var(--spacing-lg, 24px)",
      }}
      data-testid="tree-empty-state"
    >
      <p
        style={{
          fontSize: 14,
          fontWeight: 400,
          color: "var(--color-fg)",
          margin: 0,
          marginBottom: "var(--spacing-sm, 8px)",
          lineHeight: 1.5,
        }}
      >
        No notes yet.
      </p>
      <p
        style={{
          fontSize: 14,
          fontWeight: 400,
          color: "var(--color-muted)",
          margin: 0,
          lineHeight: 1.5,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          flexWrap: "wrap",
        }}
      >
        <span>Press</span>
        <FilePlus
          size={14}
          aria-hidden="true"
          style={{ display: "inline-block", color: "var(--color-muted)" }}
        />
        <span>to create your first note.</span>
      </p>
    </div>
  );
}

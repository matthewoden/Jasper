/**
 * Phase 1 sidebar — static. Per CONTEXT.md D-02 + 01-UI-SPEC.md §Sidebar:
 *   - "NOTES" header (12px semibold uppercased, text-muted, letter-spacing 0.05em)
 *   - One static row labelled "scratchpad" with the active-row treatment
 *     (2px left border in --color-accent, text-accent)
 *   - NO toolbar icons, NO interactivity in Phase 1 — Phase 3 fills the tree
 *     with react-arborist; Phase 4 adds the connection-status dot.
 *
 * The fixed 260px width comes from the parent grid template in App.tsx; we
 * also set width here so the sidebar still has a stable size if the
 * component is reused outside the grid in tests.
 */
export function Sidebar() {
  return (
    <nav
      className="bg-surface border-r border-border h-full flex flex-col"
      style={{ width: 260 }}
      aria-label="Notes navigation"
    >
      <header
        className="px-4 py-6 text-muted uppercase font-semibold"
        style={{
          fontSize: "12px",
          letterSpacing: "0.05em",
          lineHeight: 1.4,
        }}
      >
        NOTES
      </header>
      <ul className="list-none p-0 m-0">
        <li
          className="text-accent border-l-2 border-accent py-2"
          // Active-row treatment per UI-SPEC §Color §"Accent reserved for".
          // padding-left = 16px - 2px so the border doesn't shift content.
          style={{ paddingLeft: "calc(16px - 2px)" }}
          aria-current="page"
        >
          scratchpad
        </li>
      </ul>
    </nav>
  );
}

/**
 * shouldPromoteActiveNote — predicate for load-time promotion of a legacy
 * single-open note into a real tab.
 *
 * Persisted tabs win: promotion only fires when zero tabs hydrated, so a vault
 * with saved tabs is never disturbed. Pure (no store reads) so the racy
 * mount-time decision is deterministic and unit-testable.
 */
export function shouldPromoteActiveNote(
  persistedTabCount: number,
  activeNoteId: string | null,
  noteIds: ReadonlySet<string>,
): boolean {
  return (
    persistedTabCount === 0 &&
    activeNoteId !== null &&
    noteIds.has(activeNoteId)
  );
}

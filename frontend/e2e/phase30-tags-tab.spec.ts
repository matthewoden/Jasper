/**
 * gap closure (30-10 TAGS-02) — right-rail Tags tab
 * note-tags-on-tab-switch regression coverage.
 *
 * Removed: the note-tags concept (the active-note
 * live-CM6 tag section this file's single test exercised, plus its
 * useNoteTagsStore/latestTagsRef become-active-flush machinery) was
 * deleted entirely — the Tags tab is now a single vault-wide list with no
 * per-tab or per-note affordance. No salvageable vault-list assertion
 * existed in this file (it exclusively covered the removed section), so
 * the test was removed rather than reworked. Vault-wide list coverage
 * lives in phase30-rail-uat.spec.ts's TAGS-02 test.
 */

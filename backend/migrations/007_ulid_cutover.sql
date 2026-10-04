-- 007_ulid_cutover.sql — note ids move from indexer-minted UUIDs to ULIDs
-- carried in the note's frontmatter.
--
-- A legacy row cannot be mapped forward: its UUID was never written to the
-- file, so nothing on disk corroborates it. The rows are dropped and the
-- next reconcile re-adopts every note under the id its frontmatter carries.
-- note_tags and backlinks cascade; notes_fts follows through its delete
-- trigger. Bookmarks recover through their path hint.
DELETE FROM notes WHERE length(id) <> 26;

-- 003_fts.sql — Phase 7 FTS5 full-text search index (SEARCH-01, SEARCH-02).
-- Filesystem (notes/*.md content + frontmatter tags) is the source of truth
-- (DATA-01); the FTS5 index is doubly derived from the `notes` table. Wiping
-- this file plus 001's tables is never data loss — the indexer rebuilds from
-- disk (Phase 2 §4.4 three-path resilience). See DESIGN.md §9.
--
-- This migration:
--   1. Recreates the `notes` table as a rowid table so FTS5's
--      content_rowid='rowid' works (Pitfall 1 — content_rowid requires INTEGER
--      rowid; the original table was declared STRICT,WITHOUT_ROWID_OPTIMIZATION
--      in 001_initial.sql which means no implicit rowid exists).
--   2. Adds two indexer-managed columns on `notes`: `body_fts` (note body with
--      frontmatter YAML stripped, D-37) and `tag_names_fts` (space-joined tag
--      names so tag-name matches surface the note).
--   3. Creates the `notes_fts` external-content FTS5 virtual table (D-35, D-36)
--      with the unicode61 tokenizer treating `_` and `-` as word chars (D-38).
--   4. Adds three triggers so any future direct SQL mutation on `notes` keeps
--      `notes_fts` consistent. The indexer (Plan 07-03) primarily mutates via
--      these columns, so the triggers do the bookkeeping.
--
-- Plan 07-03 wires the indexer to populate body_fts/tag_names_fts on Upsert and
-- runs a startup row-count divergence check (D-36).

-- ── Step 1: Recreate notes as a standard rowid table with two new columns. ──
-- We CREATE notes_new with the same column set as 001's notes table plus
-- body_fts and tag_names_fts. The STRICT modifier is preserved but the
-- WITHOUT_ROWID_OPTIMIZATION from 001 is dropped so SQLite assigns every row
-- an implicit INTEGER rowid that FTS5's content_rowid='rowid' can map to.

CREATE TABLE notes_new (
    id               TEXT    PRIMARY KEY,                 -- UUID v4, lowercase, 36 chars
    path             TEXT    NOT NULL UNIQUE,             -- canonical rel path under notes/
    title            TEXT    NOT NULL DEFAULT '',         -- first H1 or filename-without-.md
    mtime_unix       INTEGER NOT NULL,                    -- file mtime in UNIX seconds
    size_bytes       INTEGER NOT NULL DEFAULT 0,          -- file size at last index
    checksum_sha256  TEXT    NOT NULL DEFAULT '',         -- empty unless checksum fallback used
    created_at       INTEGER NOT NULL,                    -- UNIX seconds, first-seen-by-indexer
    updated_at       INTEGER NOT NULL,                    -- UNIX seconds, last-index-touch
    body_fts         TEXT    NOT NULL DEFAULT '',         -- body with frontmatter stripped (D-37)
    tag_names_fts    TEXT    NOT NULL DEFAULT ''          -- space-joined tag names for FTS match
) STRICT;

INSERT INTO notes_new (
    id, path, title, mtime_unix, size_bytes, checksum_sha256, created_at, updated_at
) SELECT
    id, path, title, mtime_unix, size_bytes, checksum_sha256, created_at, updated_at
FROM notes;

-- Drop the index that 001_initial.sql created on notes BEFORE dropping notes.
DROP INDEX IF EXISTS idx_notes_mtime_unix;

DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;

-- Recreate the index that 001_initial.sql defined on `notes`.
CREATE INDEX idx_notes_mtime_unix ON notes(mtime_unix);

-- ── Step 2: FTS5 virtual table (external content over the recreated notes). ──
-- content='notes' tells FTS5 to use the notes table as the content source.
-- content_rowid='rowid' maps FTS5 internal rowids to the notes.rowid integer
-- (now available because 001's table storage optimization has been removed).
-- tokenize uses unicode61 with tokenchars so underscore and hyphen are treated
-- as word characters, matching identifiers like "my-tag" or "some_key" (D-38).
CREATE VIRTUAL TABLE notes_fts USING fts5(
    body,
    tag_names,
    content       = 'notes',
    content_rowid = 'rowid',
    tokenize      = "unicode61 tokenchars '_-'"
);

-- ── Step 3: Triggers keep notes_fts in lockstep with notes mutations. ──
-- The indexer's Upsert path writes body_fts/tag_names_fts into notes; the
-- INSERT/UPDATE triggers fire automatically and propagate into notes_fts.
CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, body, tag_names)
    VALUES (new.rowid, new.body_fts, new.tag_names_fts);
END;

CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, body, tag_names)
    VALUES ('delete', old.rowid, old.body_fts, old.tag_names_fts);
END;

CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, body, tag_names)
    VALUES ('delete', old.rowid, old.body_fts, old.tag_names_fts);
    INSERT INTO notes_fts(rowid, body, tag_names)
    VALUES (new.rowid, new.body_fts, new.tag_names_fts);
END;

-- ── Step 4: Initial population note. ──
-- Existing rows had body_fts='' and tag_names_fts='' from the INSERT...SELECT
-- above; the AI trigger did NOT fire for them (INSERT INTO notes_new was not
-- on the `notes` table, which didn't exist yet under that name). The FTS index
-- starts empty for pre-existing rows. Plan 07-03's startup divergence check
-- detects the empty FTS and runs a full rebuild.

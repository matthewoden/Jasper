-- 002_tags_backlinks.sql — Phase 6 tags, note_tags, and backlinks tables.
-- Filesystem (notes/*.md frontmatter tags + [[wiki-link]] body refs) is the
-- source of truth (DATA-01 + TAGS-01 + LINKS-01); every row in these
-- three tables is reconstructable by walking the filesystem (Plan 06-04
-- reconcile extension). Wiping this file alongside 001's tables is never
-- data loss — see DESIGN.md §4.4 / §7 / §8.

-- tags holds the normalized tag vocabulary (D-22: [a-z0-9_-]+ only).
-- id is an auto-increment integer (not UUID) because tags are addressed
-- by name in the API and UUIDs would be wasted entropy for a small
-- vocabulary. The name UNIQUE constraint enforces D-22 uniqueness at the
-- DB layer (defense-in-depth alongside server-side normalization).
CREATE TABLE tags (
    id   INTEGER PRIMARY KEY,
    name TEXT    NOT NULL UNIQUE             -- D-22: normalized [a-z0-9_-]+
) STRICT;

-- note_tags is the many-to-many join table between notes and tags.
-- note_id references notes(id) with CASCADE DELETE so that deleting a
-- note from the index also removes its tag associations without an
-- explicit sweep (DATA-01 derived-index rebuild safety).
-- tag_id references tags(id) with CASCADE DELETE so that when a tag is
-- fully removed (TAGS-07 Plan 06-05), all join rows vanish automatically.
-- PRIMARY KEY (note_id, tag_id) is the covering key — deduplicate join
-- rows at the DB layer. WITHOUT ROWID saves the implicit rowid overhead
-- since this table is addressed only by the composite PK.
CREATE TABLE note_tags (
    note_id TEXT    NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
) STRICT, WITHOUT ROWID;

-- backlinks: resolved OR pending references between notes.
-- source_id    = the note containing the [[...]] reference.
-- target_id    = the note the reference resolves to. NULL = pending (LINKS-04).
-- target_title = the raw title text inside [[Title]]. Stored so the rename
--                rewriter (LINKS-07) and the pending-link list can find rows
--                without re-reading the source file.
-- excerpt      = server-built HTML (sanitized by DOMPurify on the client)
--                showing the line around the reference (D-27). 200-char cap.
-- UNIQUE (source_id, target_title) collapses multiple [[Foo]] references
-- from the same source note into one row — the count badge is computed
-- at extract time (D-29). If a source note has [[Foo]] multiple times,
-- those collapse into one backlink row. The excerpt holds the FIRST match.
CREATE TABLE backlinks (
    id           INTEGER PRIMARY KEY,
    source_id    TEXT    NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    target_id    TEXT    REFERENCES notes(id) ON DELETE SET NULL,
    target_title TEXT    NOT NULL,
    excerpt      TEXT    NOT NULL DEFAULT '',
    UNIQUE (source_id, target_title)
) STRICT;

-- Indices to support GET /api/v1/notes/{id}/backlinks (look up by target)
-- and bulk operations that scan by source (reconcile, rewrite paths).
CREATE INDEX idx_backlinks_target_id ON backlinks(target_id);
CREATE INDEX idx_backlinks_source_id ON backlinks(source_id);

-- Index to support GET /api/v1/tags/{name}/notes (join note_tags → tags by tag_id).
-- The PRIMARY KEY already indexes (note_id, tag_id); this covers (tag_id) alone.
CREATE INDEX idx_note_tags_tag_id    ON note_tags(tag_id);

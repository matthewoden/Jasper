-- 005_backlink_multi_excerpt.sql — Phase 20 per-mention excerpts (D-16).
-- Filesystem (notes/*.md [[wiki-link]] body refs) is the source of truth
-- (LINKS-01); every row in `backlinks` is reconstructable by walking the
-- filesystem (internal/index/reconcile.go). Wiping this table is never
-- data loss — see CLAUDE.md's "Filesystem as source of truth" architectural
-- constraint / DESIGN.md §4.4.
--
-- 002_tags_backlinks.sql collapsed every `[[Foo]]` reference from a source
-- note into ONE row via `UNIQUE (source_id, target_title)`, with the excerpt
-- holding only the FIRST match. D-16 (this phase) requires one excerpt PER
-- `[[...]]` mention LINE instead, rendered as stacked lines within one card
-- per linking note. Storing N rows per (source_id, target_title) needs the
-- UNIQUE constraint removed; `GetBacklinks` groups rows back into one card
-- per source_id at read time via `json_group_array` (internal/index/backlinks.go).
--
-- This migration mirrors the 12-step SQLite table-rebuild recipe already
-- used in 003_fts.sql for a constraint change on a table with FK dependents
-- (sqlite.org/lang_altertable.html §7 — "Making Other Kinds Of Table Schema
-- Changes").
--
-- ── Step 0: Defer foreign-key checks for the duration of this migration. ──
-- backlinks.source_id / target_id REFERENCES notes(id); dropping and
-- recreating the table would fail the FK check immediately without this.
PRAGMA defer_foreign_keys = ON;

-- ── Step 1: Recreate backlinks with the SAME columns, minus the UNIQUE
-- (source_id, target_title) constraint. ──
CREATE TABLE backlinks_new (
    id           INTEGER PRIMARY KEY,
    source_id    TEXT    NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    target_id    TEXT    REFERENCES notes(id) ON DELETE SET NULL,
    target_title TEXT    NOT NULL,
    excerpt      TEXT    NOT NULL DEFAULT ''
) STRICT;

INSERT INTO backlinks_new (id, source_id, target_id, target_title, excerpt)
SELECT id, source_id, target_id, target_title, excerpt
FROM backlinks;

-- Drop the indices BEFORE dropping the table they reference (003_fts.sql
-- convention — dropping the table first would leave dangling index entries).
DROP INDEX IF EXISTS idx_backlinks_target_id;
DROP INDEX IF EXISTS idx_backlinks_source_id;

DROP TABLE backlinks;
ALTER TABLE backlinks_new RENAME TO backlinks;

-- Recreate both indices exactly as defined in 002_tags_backlinks.sql.
CREATE INDEX idx_backlinks_target_id ON backlinks(target_id);
CREATE INDEX idx_backlinks_source_id ON backlinks(source_id);

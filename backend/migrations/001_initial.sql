-- 001_initial.sql — Phase 2 initial schema for the SQLite derived index.
-- Filesystem (notes/*.md) is the source of truth (DATA-01); every row in
-- this database is reconstructable by walking the filesystem (Plan 02-04).
-- Wiping this file is never data loss — see DESIGN.md §4.4.

-- schema_migrations tracks which embedded migration files have been
-- applied. Plan 02-03's runner reads/writes this table inside a
-- transaction per migration (BEGIN IMMEDIATE; apply; INSERT; COMMIT).
CREATE TABLE schema_migrations (
    version    TEXT    PRIMARY KEY,        -- e.g. '001_initial.sql' (filename, not parsed integer)
    applied_at INTEGER NOT NULL            -- UNIX seconds when applied
) WITHOUT ROWID;

-- notes is the derived index of every .md file under <data-dir>/notes/.
-- id is a v4 UUID (text, lowercase 36-char hex with hyphens) generated
-- at first-index-time by the indexer; it survives renames so [[wiki-link]]
-- targets remain stable when a file moves (Phase 6).
-- path is the canonical relative path — NFC-normalized + lowercase per
-- DATA-11 — used as a UNIQUE key so case-collisions (DATA-12) become
-- a constraint violation at INSERT time.
-- mtime_unix is the file's last-modified time as observed by os.Stat
-- at index time; the incremental re-indexer compares it to the on-disk
-- mtime to decide whether to re-read (DATA-09, mtime-first per CONTEXT
-- "Deferred Ideas" — mtime vs checksum).
-- size_bytes + checksum_sha256 are populated only when the indexer
-- falls back to checksum comparison for ambiguous mtimes (e.g.
-- granularity races on case-insensitive filesystems).
CREATE TABLE notes (
    id               TEXT    PRIMARY KEY,                 -- UUID v4, lowercase, 36 chars
    path             TEXT    NOT NULL UNIQUE,             -- canonical rel path under notes/
    title            TEXT    NOT NULL DEFAULT '',         -- first H1 or filename-without-.md
    mtime_unix       INTEGER NOT NULL,                    -- file mtime in UNIX seconds
    size_bytes       INTEGER NOT NULL DEFAULT 0,          -- file size at last index
    checksum_sha256  TEXT    NOT NULL DEFAULT '',         -- empty unless checksum fallback used
    created_at       INTEGER NOT NULL,                    -- UNIX seconds, first-seen-by-indexer
    updated_at       INTEGER NOT NULL                     -- UNIX seconds, last-index-touch
) WITHOUT ROWID;

-- Index on mtime for indexer scan-windows (e.g. "all rows touched
-- since the last successful indexer run"). The UNIQUE constraint on
-- notes.path already creates an index on path.
CREATE INDEX idx_notes_mtime_unix ON notes(mtime_unix);

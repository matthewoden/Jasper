-- 008_tombstones.sql — what a deleted item used to be.
--
-- A reference to a deleted note or blob should render as deleted with its
-- last known title rather than as unknown. Rows are written when an index
-- row is removed and cleared when an id comes back (a restore from trash).
-- replaced_by is set when a blob's bytes changed in place, pointing at the
-- id that took over the path.
--
-- Derived data: a full rebuild starts with this table empty.
CREATE TABLE tombstones (
    id          TEXT    PRIMARY KEY,
    last_path   TEXT    NOT NULL DEFAULT '',
    last_title  TEXT    NOT NULL DEFAULT '',
    deleted_at  INTEGER NOT NULL,
    replaced_by TEXT
) STRICT;

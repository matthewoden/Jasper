-- 009_blobs.sql — attachments get identity by content.
--
-- A blob is a distinct sequence of bytes: its id is sha256-<first 16 hex> of
-- the file, extended to the full digest only if two different files ever
-- share a prefix. Identical files at several paths are one blob with several
-- blob_paths rows. Editing a file in place produces a new blob; the old id is
-- tombstoned with replaced_by pointing at the new one.
--
-- blob_paths carries the (mtime, size) pair that lets reconcile skip the
-- hash for an unchanged file.
--
-- items is the one-row-per-item view that id lookups read, so note metadata
-- keeps a single home in notes.
CREATE TABLE blobs (
    id         TEXT    PRIMARY KEY,
    sha256     TEXT    NOT NULL,
    mime       TEXT    NOT NULL DEFAULT '',
    size       INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE blob_paths (
    path       TEXT    PRIMARY KEY,
    blob_id    TEXT    NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,
    mtime_unix INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_blob_paths_blob_id ON blob_paths(blob_id);

CREATE VIEW items AS
    SELECT id, 'note' AS kind, path, title, mtime_unix AS updated_at
    FROM notes
    UNION ALL
    SELECT b.id,
           'blob' AS kind,
           p.path,
           replace(p.path, rtrim(p.path, replace(p.path, '/', '')), '') AS title,
           p.mtime_unix AS updated_at
    FROM blobs b
    JOIN blob_paths p ON p.blob_id = b.id
    WHERE p.path = (SELECT MIN(path) FROM blob_paths WHERE blob_id = b.id);

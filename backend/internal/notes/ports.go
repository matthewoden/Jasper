package notes

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// FileStore is the port over the filesystem adapter (internal/fsstore).
// Defined here per the hexagonal-lite layout: notes/ owns the interface,
// fsstore/ implements it. Phase 2's SQLite Index is a second port; Phase
// 4's WebSocket broadcaster will be a third in the same fashion.
type FileStore interface {
	// Read returns the bytes at relPath under the configured data root.
	// Returns an error wrapping fs.ErrNotExist if the file does not exist.
	// Implementations canonicalize relPath internally (NFC + lowercase
	// + escape checks) per DATA-11.
	Read(relPath string) ([]byte, error)

	// WriteAtomic writes data to relPath durably (DATA-13). Implementations
	// canonicalize relPath internally and route through the atomic-write
	// primitive (temp + fsync(file) + rename + fsync(parent dir)).
	WriteAtomic(relPath string, data []byte) error

	// Stat returns the modification time of relPath, used by Service to
	// populate Note.UpdatedAt. Returns an error wrapping fs.ErrNotExist
	// if the file is missing.
	Stat(relPath string) (modTime time.Time, err error)
}

// Index is the port over the SQLite derived-index adapter. The
// concrete implementation lives in internal/index (Phase 2 Plan 02-04).
//
// Per ARCHITECTURE.md §11.1 the canonical save path is filesystem FIRST,
// SQLite index SECOND, broadcast THIRD. The Index is a derived
// projection of the filesystem (DATA-01); wiping the database is never
// data loss because Reconcile rebuilds it from the .md files.
//
// Phase 1 tests construct notes.Service with a nil Index — Service
// substitutes nopIndex{} (see service.go) so no-op behavior is the
// default for callers that don't wire the real indexer. Plan 02-06's
// composition root always passes a real *index.Indexer.
type Index interface {
	// Upsert inserts or updates the index row for rec. Called from
	// Service.Update AFTER WriteAtomic succeeds (file-FIRST). On a
	// case-insensitive path conflict with an existing row whose ID
	// differs, returns ErrCaseCollision (DATA-12); the API layer maps
	// this to 409. Other errors are LOGGED by the caller and the file
	// write is preserved — the index is recoverable via Reconcile.
	Upsert(ctx context.Context, rec NoteRecord) error

	// Delete removes the index row for the given UUID. No-op if the row
	// is already absent (idempotent — file-deletes can race with the
	// indexer scan).
	Delete(ctx context.Context, id uuid.UUID) error

	// List returns one NoteSummary per indexed note for the file-tree /
	// notes-list UI. Order is undefined at the port level; the API
	// handler / UI is responsible for any sort.
	List(ctx context.Context) ([]NoteSummary, error)
}

// NoteRecord is the canonical projection of a .md file into the index.
//
// Field shapes are LOCKED — both the indexer (Plan 02-04b) and
// Service.Update populate this struct, and the SQLite store reads from
// it column-for-column.
//
// Checksum is reserved for Phase 7 (FTS5 + DATA-09 checksum-fallback);
// Phase 2 always populates this as the empty string. The notes table
// schema includes a `checksum_sha256 TEXT NOT NULL DEFAULT ''` column
// from 001_initial.sql, populated as "" throughout Phase 2.
//
// MTimeUnix is the file's last-modified time as observed by os.Stat at
// index time (the on-disk mtime). UpdatedAtUnix is the index-touch time
// — when the indexer last wrote this row — and is distinct from
// MTimeUnix because the same file mtime can be re-touched by Reconcile
// without the file actually changing.
type NoteRecord struct {
	ID            uuid.UUID
	Path          string // canonical relpath (NFC + lowercase) under notes/
	Title         string // first-H1 or filename-without-.md
	MTimeUnix     int64
	SizeBytes     int64
	Checksum      string // SHA-256 hex; ALWAYS empty in Phase 2 (deferred to Phase 7)
	UpdatedAtUnix int64  // index-touch time (NOT file mtime)
}

// NoteSummary is the projection returned by Index.List for the
// file-tree / notes-list UI. UpdatedAt is the file's mtime (NOT the
// index-touch time) so the UI shows file-relevant timestamps.
//
// The wire shape (api.Note in openapi.yaml's GetNotes200JSONResponse)
// is intentionally a subset of this struct; the API handler in Plan
// 02-04b translates NoteSummary -> api.Note. Threat T-02-04a-02 keeps
// internal-only fields (Checksum, UpdatedAtUnix) off the wire.
type NoteSummary struct {
	ID        uuid.UUID
	Path      string
	Title     string
	UpdatedAt time.Time
}

// Package notes is the domain layer for note read/write operations.
// It is the testable core of Jasper. Imports nothing project-specific
// except its own ports (FileStore, Index — see ports.go); concrete
// adapters live in fsstore/ and internal/index/.
//
// Per the canonical save ordering: filesystem FIRST, SQLite index SECOND,
// broadcast THIRD. The SQLite Index and Broadcaster ports are declared here;
// concrete implementations are wired at the composition root.
package notes

import (
	"errors"
	"time"

	"github.com/google/uuid"
)

// Note is the domain object — distinct from api.Note (the wire shape) so
// the service is not coupled to HTTP. The handler in internal/api
// translates notes.Note -> api.Note.
type Note struct {
	ID        uuid.UUID
	Path      string    // canonicalized relative path under notes/ (NFC + lowercase)
	Content   string    // raw markdown
	UpdatedAt time.Time // wall-clock UTC of the last successful write
}

// ETag renders a mtime as the opaque version token clients send back as
// If-Match. Update's comparator is built with this same function, so a token
// handed out by a read can never disagree with the one a write compares
// against — the two-clocks failure mode that let index-backed second-precision
// timestamps masquerade as comparators.
func ETag(modTime time.Time) string {
	return modTime.UTC().Format(time.RFC3339Nano)
}

// Sentinel errors. Callers gate behavior with errors.Is.
var (
	// ErrNotFound is returned when the requested UUID is not in the
	// registry, or the underlying file is missing on disk.
	ErrNotFound = errors.New("notes: note not found")
	// ErrInvalidContent is returned for content that fails validation (e.g.
	// empty title, forbidden characters). Empty markdown content is legal.
	ErrInvalidContent = errors.New("notes: invalid content")
	// ErrCaseCollision is returned by Index.Upsert (and propagated by
	// Service.Update) when a note's canonical path conflicts case-
	// insensitively with an existing different note. The API layer maps
	// this to HTTP 409 Conflict; the UI surfaces a "rename would collide
	// with an existing note" toast. Enforced by the SQLite UNIQUE constraint
	// on notes.path (see 001_initial.sql).
	ErrCaseCollision = errors.New("notes: case-insensitive path collision with existing note")

	// ErrStaleWrite is returned when If-Match does not match the file's mtime.
	//
	// Update wraps it in a *StaleWriteInfo carrying the already-statted mtime;
	// use errors.As rather than a follow-up Get, which races a third writer.
	ErrStaleWrite = errors.New("notes: stale write — If-Match mismatch")

	// ErrTagNotFound is returned by Index.RenameTag and Index.DeleteTag when
	// the named tag does not exist in the index.
	ErrTagNotFound = errors.New("notes: tag not found")

	// ErrTagCollision is returned by Index.RenameTag when newName already
	// exists as a tag name.
	ErrTagCollision = errors.New("notes: tag already exists")

	// ErrInvalidTagName is returned when a tag name violates the allowed charset
	// ([a-z0-9_-]+). Both the service layer and the API handler check this.
	ErrInvalidTagName = errors.New("notes: invalid tag name (allowed: [a-z0-9_-]+)")
)

// StaleWriteInfo carries the current file mtime alongside ErrStaleWrite
// so callers can surface a comparator without a second filesystem Stat
// (which would race a third writer). Implements errors.Is for ErrStaleWrite
// so existing `errors.Is(err, ErrStaleWrite)` checks continue to work.
type StaleWriteInfo struct {
	// Current is the file's mtime at the moment Service.Update detected
	// the If-Match mismatch — same Stat call that produced the mismatch
	// verdict, so there is no TOCTOU window between the verdict and the
	// reported comparator.
	Current time.Time
}

// Error implements the error interface.
func (e *StaleWriteInfo) Error() string {
	return ErrStaleWrite.Error()
}

// Unwrap allows errors.Is(err, ErrStaleWrite) to keep matching.
func (e *StaleWriteInfo) Unwrap() error {
	return ErrStaleWrite
}

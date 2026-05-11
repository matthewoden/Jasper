// Package notes is the domain layer for note read/write operations.
// It is the testable core of Jasper. Imports nothing project-specific
// except its own ports (FileStore, Index — see ports.go); concrete
// adapters live in fsstore/ (Phase 1) and (Phase 2) db/.
//
// Per ARCHITECTURE.md §11.1 the canonical save path is filesystem FIRST,
// SQLite index SECOND, broadcast THIRD. Phase 1 only does step ONE — the
// SQLite Index port is declared but unimplemented; the broadcaster is
// absent. Phase 2 plugs in a real Index without changing this package's
// signatures; Phase 4 adds the broadcaster the same way.
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

// Sentinel errors. Callers gate behavior with errors.Is.
var (
	// ErrNotFound is returned when the requested UUID is not in the
	// registry, or the underlying file is missing on disk.
	ErrNotFound = errors.New("notes: note not found")
	// ErrInvalidContent is reserved for Phase 2+ validation (e.g. content
	// too large). Phase 1 accepts any content (including empty markdown).
	ErrInvalidContent = errors.New("notes: invalid content")
	// ErrCaseCollision is returned by Index.Upsert (and propagated by
	// Service.Update) when a note's canonical path conflicts case-
	// insensitively with an existing different note (DATA-12). The API
	// layer maps this to HTTP 409 Conflict; the UI surfaces a "rename
	// would collide with an existing note" toast. The underlying SQLite
	// UNIQUE constraint on notes.path is the enforcement point — see
	// 001_initial.sql.
	ErrCaseCollision = errors.New("notes: case-insensitive path collision with existing note")

	// ErrStaleWrite is returned by Service.Update when the supplied
	// If-Match value does not match the current file's mtime (SYNC-06).
	// The API layer maps this to HTTP 409 with `code: stale_write` and
	// `current_updated_at` in the body so the client can show the
	// Save-anyway / Discard banner per SYNC-05.
	//
	// BL-02: Service.Update returns a *StaleWriteInfo that wraps this
	// sentinel — handlers should `errors.As(err, &swErr)` to obtain the
	// already-statted mtime instead of issuing a second Get (which races
	// against a third writer between the failed Update's Stat and the
	// follow-up Get's Stat).
	ErrStaleWrite = errors.New("notes: stale write — If-Match mismatch")

	// Phase 6 Plan 06-05 Task 3: tag operation sentinels.
	// Defined in the notes domain so the Index port and the service can
	// use them without a circular import (index imports notes, notes does
	// NOT import index).

	// ErrTagNotFound is returned by Index.RenameTag and Index.DeleteTag when
	// the named tag does not exist in the index (D-22 / TAGS-03).
	ErrTagNotFound = errors.New("notes: tag not found")

	// ErrTagCollision is returned by Index.RenameTag when newName already
	// exists as a tag name (D-22 / TAGS-04).
	ErrTagCollision = errors.New("notes: tag already exists")

	// ErrInvalidTagName is returned when a tag name violates the D-22 charset
	// rule ([a-z0-9_-]+). Both the service layer and the API handler check this.
	ErrInvalidTagName = errors.New("notes: invalid tag name (allowed: [a-z0-9_-]+)")
)

// StaleWriteInfo carries the current file mtime alongside ErrStaleWrite
// so callers can surface a comparator without a second filesystem Stat
// (which would race a third writer — BL-02). Implements errors.Is for
// ErrStaleWrite so existing `errors.Is(err, ErrStaleWrite)` checks
// continue to work.
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

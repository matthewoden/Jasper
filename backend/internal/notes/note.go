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
)

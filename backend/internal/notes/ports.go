package notes

import "time"

// FileStore is the port over the filesystem adapter (internal/fsstore).
// Defined here per the hexagonal-lite layout: notes/ owns the interface,
// fsstore/ implements it. Phase 2's SQLite Index will be a second port.
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

// Index is the port over the SQLite derived-index adapter. NOT IMPLEMENTED
// in Phase 1 — declared here so notes.Service has the correct constructor
// shape and Phase 2 plugs in the concrete impl without changing the
// service. The Phase 1 Service constructor accepts a nil Index and skips
// Index calls accordingly. Phase 4 will hook the ws.Broadcaster as a
// third port in the same fashion.
//
// Phase 2 will add UpsertNote, GetNote, etc. — left empty in Phase 1 so
// adding methods is purely additive.
type Index interface{}

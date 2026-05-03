package fsstore

import (
	"fmt"
	"os"
	"time"
)

// Store is the concrete FileStore for a single data root (e.g.
// ~/.jasper/notes/). It routes every operation through Canonicalize
// (the case-collision / NFC / symlink-escape gate — Pitfall 2) and
// AtomicWrite (the durable-write primitive — Pitfall 3 / DATA-13).
//
// Plan 04's main.go constructs Store with the resolved --data-dir /
// $JASPER_DATA_DIR / default-`~/.jasper/notes` value (CONTEXT.md D-07).
type Store struct {
	root string // absolute path to the notes/ directory
}

// NewStore returns a Store rooted at notesDir. The directory MUST exist;
// caller (Plan 04 main.go) is responsible for mkdir.
func NewStore(notesDir string) *Store {
	return &Store{root: notesDir}
}

// Read returns the bytes at relPath under the store's root.
// relPath is canonicalized (NFC + lowercase + escape checks) before
// touching the filesystem.
func (s *Store) Read(relPath string) ([]byte, error) {
	abs, err := Canonicalize(s.root, relPath)
	if err != nil {
		return nil, fmt.Errorf("fsstore.Read(%q): %w", relPath, err)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err // os.ReadFile returns errors that wrap fs.ErrNotExist already
	}
	return data, nil
}

// WriteAtomic writes data to relPath using the AtomicWrite primitive.
// relPath is canonicalized internally.
func (s *Store) WriteAtomic(relPath string, data []byte) error {
	abs, err := Canonicalize(s.root, relPath)
	if err != nil {
		return fmt.Errorf("fsstore.WriteAtomic(%q): %w", relPath, err)
	}
	return AtomicWrite(abs, data)
}

// Stat returns the modification time of relPath.
func (s *Store) Stat(relPath string) (time.Time, error) {
	abs, err := Canonicalize(s.root, relPath)
	if err != nil {
		return time.Time{}, fmt.Errorf("fsstore.Stat(%q): %w", relPath, err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return time.Time{}, err
	}
	return info.ModTime(), nil
}

// CreateFile delegates to the package-level primitive in ops.go,
// supplying s.root as the data root. Plan 03-03's notes service uses
// these wrappers to pair every FS mutation with an index update under
// a single transaction.
func (s *Store) CreateFile(relPath string) error {
	return CreateFile(s.root, relPath)
}

// DeleteFile delegates to the package-level DeleteFile primitive,
// supplying s.root as the data root.
func (s *Store) DeleteFile(relPath string) error {
	return DeleteFile(s.root, relPath)
}

// MoveFile delegates to the package-level MoveFile primitive, supplying
// s.root as the data root.
func (s *Store) MoveFile(oldRelPath, newRelPath string) error {
	return MoveFile(s.root, oldRelPath, newRelPath)
}

// CreateDir delegates to the package-level CreateDir primitive, supplying
// s.root as the data root.
func (s *Store) CreateDir(relPath string) error {
	return CreateDir(s.root, relPath)
}

// DeleteDir delegates to the package-level DeleteDir primitive, supplying
// s.root as the data root.
func (s *Store) DeleteDir(relPath string, recursive bool) error {
	return DeleteDir(s.root, relPath, recursive)
}

// MoveDir delegates to the package-level MoveDir primitive, supplying
// s.root as the data root.
func (s *Store) MoveDir(oldRelPath, newRelPath string) error {
	return MoveDir(s.root, oldRelPath, newRelPath)
}

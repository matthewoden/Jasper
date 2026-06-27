package fsstore

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Store is the concrete FileStore for a single data root (e.g.
// ~/.jasper/notes/). It routes every operation through Canonicalize
// (case-collision / NFC / symlink-escape gate) and AtomicWrite
// (durable-write primitive).
type Store struct {
	root    string
	dataDir string // parent of notesDir; used for trash operations
}

// NewStore returns a Store rooted at notesDir. The directory MUST already exist.
// dataDir is derived as filepath.Dir(notesDir); callers do not need to change.
func NewStore(notesDir string) *Store {
	return &Store{root: notesDir, dataDir: filepath.Dir(notesDir)}
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
		return nil, err
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
// supplying s.root as the data root.
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

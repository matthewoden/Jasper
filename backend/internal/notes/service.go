package notes

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"

	"github.com/google/uuid"
)

// Service is the Phase 1 notes domain service. Get reads the file via
// FileStore; Update writes it via FileStore.WriteAtomic (DATA-13).
//
// Per ARCHITECTURE.md §11.1 the canonical save path is filesystem FIRST,
// then Index, then broadcast. Phase 1 only does step ONE — the Index port
// is a typed interface{} (see ports.go) and the broadcaster is absent.
// Phases 2 and 4 layer in additively without changing this signature.
type Service struct {
	files    FileStore
	registry *Registry
	log      *slog.Logger
	// index Index — explicitly omitted from Phase 1; the constructor
	// still accepts it so Plan 04 / Phase 2 wire-up is signature-stable.
}

// NewService constructs the Phase 1 service. The index parameter is
// declared so Plan 04's main.go and Phase 2's SQLite Index plug in
// without changing the constructor shape. Pass nil in Phase 1.
//
// A nil log is replaced with slog.Default() so callers don't have to
// thread a logger through every test.
func NewService(files FileStore, _ Index, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{
		files:    files,
		registry: NewRegistry(),
		log:      log,
	}
}

// Get returns the Note for the given UUID, or ErrNotFound if the UUID is
// not in the registry or the underlying file is missing on disk.
//
// File-not-found is mapped to ErrNotFound rather than surfaced raw because
// the API layer treats both as a 404 — and the registry "knowing" about a
// UUID does not guarantee the file was seeded yet (Plan 04 main.go is
// responsible for seeding scratchpad.md on startup; if that step is
// skipped this returns ErrNotFound rather than a more confusing 500).
func (s *Service) Get(_ context.Context, id uuid.UUID) (Note, error) {
	relPath, ok := s.registry.Lookup(id)
	if !ok {
		return Note{}, fmt.Errorf("notes.Get(%s): %w", id, ErrNotFound)
	}
	data, err := s.files.Read(relPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Note{}, fmt.Errorf("notes.Get(%s): %w", id, ErrNotFound)
		}
		return Note{}, fmt.Errorf("notes.Get(%s): read: %w", id, err)
	}
	modTime, err := s.files.Stat(relPath)
	if err != nil {
		return Note{}, fmt.Errorf("notes.Get(%s): stat: %w", id, err)
	}
	return Note{
		ID:        id,
		Path:      relPath,
		Content:   string(data),
		UpdatedAt: modTime.UTC(),
	}, nil
}

// Update writes new content for the given UUID. Returns the updated Note
// (or ErrNotFound if the UUID is unknown). Filesystem write FIRST per
// ARCHITECTURE.md §11.1; Index update + broadcast are Phases 2 & 4.
//
// Empty content is allowed (Phase 1 has a textarea — empty markdown is
// a legal state).
func (s *Service) Update(_ context.Context, id uuid.UUID, content string) (Note, error) {
	relPath, ok := s.registry.Lookup(id)
	if !ok {
		return Note{}, fmt.Errorf("notes.Update(%s): %w", id, ErrNotFound)
	}
	if err := s.files.WriteAtomic(relPath, []byte(content)); err != nil {
		return Note{}, fmt.Errorf("notes.Update(%s): write: %w", id, err)
	}
	modTime, err := s.files.Stat(relPath)
	if err != nil {
		return Note{}, fmt.Errorf("notes.Update(%s): stat after write: %w", id, err)
	}
	return Note{
		ID:        id,
		Path:      relPath,
		Content:   content,
		UpdatedAt: modTime.UTC(),
	}, nil
}

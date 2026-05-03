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
// then Index, then broadcast. Plan 02-04a wires step TWO (Index.Upsert
// AFTER WriteAtomic). The broadcaster is added in Phase 4 the same way.
//
// File-FIRST contract: if Index.Upsert fails for a non-collision reason,
// the file is left on disk unchanged and the next Reconcile heals the
// index. The only error class that propagates to the caller is
// ErrCaseCollision (DATA-12), which the API layer maps to 409.
type Service struct {
	files    FileStore
	index    Index
	registry *Registry
	log      *slog.Logger
}

// NewService constructs the service. The index parameter is required
// in production (Plan 02-06's composition root passes a real
// *index.Indexer); callers may pass nil and Service substitutes a
// nopIndex no-op so Phase 1 tests and any callers that don't need the
// derived index continue to work unchanged.
//
// A nil log is replaced with slog.Default() so callers don't have to
// thread a logger through every test.
func NewService(files FileStore, index Index, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	if index == nil {
		index = nopIndex{}
	}
	return &Service{
		files:    files,
		index:    index,
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

// Update writes new content for the given UUID. Filesystem write FIRST
// per ARCHITECTURE.md §11.1; Index.Upsert SECOND; broadcast (Phase 4)
// THIRD. Returns the updated Note (or ErrNotFound if the UUID is
// unknown).
//
// Empty content is allowed (Phase 1 has a textarea — empty markdown is
// a legal state).
//
// Index ordering and error semantics:
//
//   - On WriteAtomic failure: return wrapped error; index is NOT touched
//     (the on-disk state did not change).
//   - On Stat-after-write failure: return wrapped error; the file was
//     written but we cannot report a UpdatedAt — surface to caller.
//   - On Index.Upsert returning ErrCaseCollision: return the error
//     wrapped. The file IS on disk (file-FIRST contract). The next
//     Reconcile will re-attempt Upsert; in the meantime the API layer
//     surfaces 409 to the user.
//   - On any other Index.Upsert error: log + continue. The file write
//     is preserved because the filesystem is the source of truth
//     (DATA-01); the index is recoverable via Reconcile. We do NOT
//     return the error to the caller — a transient SQLite error must
//     not surface as a 500 when the user's content is safely on disk.
func (s *Service) Update(ctx context.Context, id uuid.UUID, content string) (Note, error) {
	relPath, ok := s.registry.Lookup(id)
	if !ok {
		return Note{}, fmt.Errorf("notes.Update(%s): %w", id, ErrNotFound)
	}
	// File FIRST per ARCHITECTURE §11.1.
	if err := s.files.WriteAtomic(relPath, []byte(content)); err != nil {
		return Note{}, fmt.Errorf("notes.Update(%s): write: %w", id, err)
	}
	modTime, err := s.files.Stat(relPath)
	if err != nil {
		return Note{}, fmt.Errorf("notes.Update(%s): stat after write: %w", id, err)
	}
	// Index SECOND. ALWAYS runs AFTER WriteAtomic. nopIndex is a no-op
	// for callers that didn't wire the real indexer.
	rec := NoteRecord{
		ID:            id,
		Path:          relPath,
		Title:         "", // index-side extractTitle is the source of truth (Plan 02-04a Task 3 / 02-04b store.go)
		MTimeUnix:     modTime.UTC().Unix(),
		SizeBytes:     int64(len(content)),
		Checksum:      "", // Phase 7 only
		UpdatedAtUnix: modTime.UTC().Unix(),
	}
	if err := s.index.Upsert(ctx, rec); err != nil {
		if errors.Is(err, ErrCaseCollision) {
			// DATA-12: API layer maps to 409. The file is on disk
			// (file-FIRST); next Reconcile re-converges the index.
			return Note{}, fmt.Errorf("notes.Update(%s): %w", id, err)
		}
		// File-FIRST contract: a transient index error must not fail
		// the save. Log and return success — the user's content is
		// durably on disk; Reconcile recovers the index.
		s.log.Error("notes.Update: index upsert failed (file is on disk; recoverable via Reconcile)",
			"id", id.String(),
			"path", relPath,
			"err", err,
		)
	}
	return Note{
		ID:        id,
		Path:      relPath,
		Content:   content,
		UpdatedAt: modTime.UTC(),
	}, nil
}

// nopIndex is the no-op fallback used when callers pass nil to
// NewService. Lives in service.go (next to the only constructor that
// substitutes it) so the fallback wiring is co-located with its
// callers — same layout pattern as api.nilStatusProvider in handlers.go.
//
// This is intentionally a private type: production callers (Plan 02-06's
// composition root) always wire a real *index.Indexer, and Phase 1
// tests pass nil for backwards compatibility. Threat T-02-04a-03 is
// accepted at the code-review gate: the smoke test in Plan 02-06
// exercises the real wiring path end-to-end.
type nopIndex struct{}

func (nopIndex) Upsert(_ context.Context, _ NoteRecord) error  { return nil }
func (nopIndex) Delete(_ context.Context, _ uuid.UUID) error   { return nil }
func (nopIndex) List(_ context.Context) ([]NoteSummary, error) { return nil, nil }

// Phase 3 Plan 03-03 additions — nopIndex no-ops. The reconciler heals
// any state in a real-index world (T-03-03-08 mitigation: misconfigured
// caller gets a quiet failure mode rather than a panic).
func (nopIndex) LookupByPath(_ context.Context, _ string) (NoteRecord, error) {
	return NoteRecord{}, ErrNotFound
}
func (nopIndex) MovePathPrefix(_ context.Context, _, _ string) (int, error) { return 0, nil }
func (nopIndex) DeleteByPathPrefix(_ context.Context, _ string) (int, error) { return 0, nil }

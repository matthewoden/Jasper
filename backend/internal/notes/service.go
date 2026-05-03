package notes

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"path"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

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

// ----------------------------------------------------------------------
// Plan 03-03: Service mutations (Create / Delete / Move + Folder ops)
// ----------------------------------------------------------------------
//
// Each mutation is one logical atomic FS+SQLite operation. The atomicity
// contract is documented per-method below; the load-bearing rule is that
// neither the FS nor the index is left in a half-written state when the
// operation returns. Best-effort rollback paths are explicitly noted —
// the reconciler (DESIGN.md §4.4) is the safety net for any window we
// cannot close transactionally.

// Create creates a new note at <parentPath>/<title>.md. The path is
// canonicalized inside FileStore.CreateFile (DATA-11); collision
// rejection (DATA-12) and atomic temp+rename (DATA-13) are delegated.
//
// FS-FIRST contract: file is created, then index is upserted, then the
// registry is updated. On Index.Upsert failure AFTER successful file
// creation, the file is deleted in a best-effort cleanup and the index
// error is returned wrapped. The reconciler heals any half-state if the
// cleanup fails (DESIGN.md §4.4).
func (s *Service) Create(ctx context.Context, parentPath, title string) (NoteSummary, error) {
	if err := validateNoteTitle(title); err != nil {
		return NoteSummary{}, fmt.Errorf("notes.Create: %w", err)
	}
	relPath := buildNotePath(parentPath, title)

	if err := s.files.CreateFile(relPath); err != nil {
		return NoteSummary{}, fmt.Errorf("notes.Create(%s): %w", relPath, err)
	}

	id := uuid.New()
	now := time.Now().UTC()
	rec := NoteRecord{
		ID:            id,
		Path:          canonicalRelPath(relPath),
		Title:         deriveTitleFromFilename(title),
		MTimeUnix:     now.Unix(),
		SizeBytes:     0,
		Checksum:      "",
		UpdatedAtUnix: now.Unix(),
	}
	if err := s.index.Upsert(ctx, rec); err != nil {
		// Best-effort rollback. If this fails, the reconciler heals.
		if delErr := s.files.DeleteFile(relPath); delErr != nil {
			s.log.Warn("notes.Create: rollback DeleteFile failed (reconciler will heal)",
				"path", relPath, "err", delErr)
		}
		return NoteSummary{}, fmt.Errorf("notes.Create(%s): index upsert: %w", relPath, err)
	}
	s.registry.Add(id, rec.Path)
	return NoteSummary{
		ID:        id,
		Path:      rec.Path,
		Title:     rec.Title,
		UpdatedAt: now,
	}, nil
}

// Delete removes a note by id. ORDER INVERTED vs Create / Update:
// index.Delete runs FIRST so the row is gone before we unlink the file
// (prevents a window where the file is gone but the index still says
// "exists" — a concurrent GET /tree would 404 on click).
//
// On FS-delete failure AFTER successful index delete, the index row is
// re-Upserted (best-effort) so the row reappears and the user can retry.
// The reconciler heals if the re-Upsert itself fails.
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	relPath, ok := s.registry.Lookup(id)
	if !ok {
		return fmt.Errorf("notes.Delete(%s): %w", id, ErrNotFound)
	}

	// Capture the existing record for rollback purposes BEFORE we touch
	// the index. LookupByPath returns ErrNotFound if the index has no row
	// — that's fine; we proceed with the FS delete and skip the rollback.
	prior, lookupErr := s.index.LookupByPath(ctx, relPath)
	priorKnown := lookupErr == nil

	// Index FIRST (per "<objective>" Delete-note inversion).
	if err := s.index.Delete(ctx, id); err != nil {
		return fmt.Errorf("notes.Delete(%s): index delete: %w", id, err)
	}

	if err := s.files.DeleteFile(relPath); err != nil {
		// Best-effort rollback — re-Upsert the row so the user can retry.
		if priorKnown {
			if upsertErr := s.index.Upsert(ctx, prior); upsertErr != nil {
				s.log.Warn("notes.Delete: rollback Upsert failed (reconciler will heal)",
					"id", id.String(), "path", relPath, "err", upsertErr)
			}
		} else {
			s.log.Warn("notes.Delete: FS-delete failed and prior row unknown (reconciler will heal)",
				"id", id.String(), "path", relPath, "err", err)
		}
		return fmt.Errorf("notes.Delete(%s): %w", id, err)
	}
	s.registry.Remove(id)
	return nil
}

// Move renames a note. FS-FIRST: rename the file, then UPDATE the index
// row's path inside a fresh Upsert (which carries the same UUID +
// existing fields, only Path changes), then update the registry. On
// Index.Upsert failure AFTER successful FS rename, the file is moved
// back (best-effort).
//
// The new path is canonicalized inside FileStore.MoveFile per DATA-11.
func (s *Service) Move(ctx context.Context, id uuid.UUID, newPath string) (NoteSummary, error) {
	oldRelPath, ok := s.registry.Lookup(id)
	if !ok {
		return NoteSummary{}, fmt.Errorf("notes.Move(%s): %w", id, ErrNotFound)
	}
	canonNew := canonicalRelPath(newPath)

	if err := s.files.MoveFile(oldRelPath, canonNew); err != nil {
		return NoteSummary{}, fmt.Errorf("notes.Move(%s): %w", id, err)
	}

	// Capture existing record from the index so we preserve title /
	// mtime / size while updating the path. LookupByPath uses the OLD
	// path (the row hasn't been touched yet).
	rec, err := s.index.LookupByPath(ctx, oldRelPath)
	if err != nil {
		// The FS rename succeeded but the index has no row — most
		// likely a transient state during reconcile. Mint a fresh
		// minimal record so the index gets re-populated; the
		// reconciler will heal title/size/mtime later.
		rec = NoteRecord{
			ID:            id,
			Path:          canonNew,
			MTimeUnix:     time.Now().UTC().Unix(),
			UpdatedAtUnix: time.Now().UTC().Unix(),
		}
	} else {
		rec.Path = canonNew
		rec.UpdatedAtUnix = time.Now().UTC().Unix()
	}

	if err := s.index.Upsert(ctx, rec); err != nil {
		// Best-effort rollback — move the file back to the old path.
		if mvErr := s.files.MoveFile(canonNew, oldRelPath); mvErr != nil {
			s.log.Warn("notes.Move: rollback MoveFile failed (reconciler will heal)",
				"id", id.String(), "oldPath", oldRelPath, "newPath", canonNew, "err", mvErr)
		}
		return NoteSummary{}, fmt.Errorf("notes.Move(%s): index upsert: %w", id, err)
	}
	s.registry.Rename(id, canonNew)
	return NoteSummary{
		ID:        id,
		Path:      canonNew,
		Title:     rec.Title,
		UpdatedAt: time.Unix(rec.MTimeUnix, 0).UTC(),
	}, nil
}

// CreateFolder creates an empty directory at <parentPath>/<name>.
// Folders have no SQLite identity — the index is over .md files only —
// so this is pure FS work. Returns the canonical relpath of the new
// folder.
func (s *Service) CreateFolder(_ context.Context, parentPath, name string) (string, error) {
	if err := validateFolderName(name); err != nil {
		return "", fmt.Errorf("notes.CreateFolder: %w", err)
	}
	relPath := buildFolderPath(parentPath, name)
	if err := s.files.CreateDir(relPath); err != nil {
		return "", fmt.Errorf("notes.CreateFolder(%s): %w", relPath, err)
	}
	return canonicalRelPath(relPath), nil
}

// DeleteFolder removes a folder. With recursive=false: rmdir if empty,
// otherwise ErrFolderNotEmpty (no index work — empty folder has no .md
// rows by definition). With recursive=true: rmtree the FS subtree FIRST,
// then DELETE FROM notes WHERE path LIKE prefix/% in one batch, then
// drop every removed id from the registry.
//
// Reverse-locked from delete-note (FS first, SQLite second) because
// dir-delete is rmtree-style and the SQLite cleanup is a derived
// bookkeeping op. On index-delete failure AFTER FS rmtree, the FS is
// already gone — log loudly and return; reconciler heals.
func (s *Service) DeleteFolder(ctx context.Context, folderPath string, recursive bool) error {
	canon := canonicalRelPath(folderPath)
	if !recursive {
		if err := s.files.DeleteDir(folderPath, false); err != nil {
			return fmt.Errorf("notes.DeleteFolder(%s): %w", canon, err)
		}
		return nil
	}

	// Recursive: collect the set of doomed ids BEFORE the FS delete so
	// we know what to remove from the registry afterward.
	doomedIDs := s.registry.idsUnder(canon)

	if err := s.files.DeleteDir(folderPath, true); err != nil {
		return fmt.Errorf("notes.DeleteFolder(%s): %w", canon, err)
	}
	if _, err := s.index.DeleteByPathPrefix(ctx, canon); err != nil {
		// FS is already gone — surface the error AND log loudly. The
		// reconciler will eventually heal stale index rows on next
		// startup / admin/reindex.
		s.log.Warn("notes.DeleteFolder: index batch-delete failed (RECONCILER WILL HEAL on next startup)",
			"path", canon, "err", err)
		return fmt.Errorf("notes.DeleteFolder(%s): index delete: %w", canon, err)
	}
	for _, id := range doomedIDs {
		s.registry.Remove(id)
	}
	return nil
}

// MoveFolder renames a folder. FS-FIRST: rename the directory, then
// batch-UPDATE every notes row whose path starts with oldPath/ to start
// with newPath/, then update every registry entry under the old prefix.
//
// fsstore.MoveDir enforces ErrCycle (move into self / descendant) and
// ErrCaseCollision pre-FS-write. On index-batch failure AFTER successful
// FS rename, the FS is best-effort moved back.
func (s *Service) MoveFolder(ctx context.Context, oldPath, newPath string) (string, error) {
	canonOld := canonicalRelPath(oldPath)
	canonNew := canonicalRelPath(newPath)

	if err := s.files.MoveDir(oldPath, newPath); err != nil {
		return "", fmt.Errorf("notes.MoveFolder(%s→%s): %w", canonOld, canonNew, err)
	}

	if _, err := s.index.MovePathPrefix(ctx, canonOld+"/", canonNew+"/"); err != nil {
		// Best-effort FS rollback.
		if mvErr := s.files.MoveDir(newPath, oldPath); mvErr != nil {
			s.log.Warn("notes.MoveFolder: rollback MoveDir failed (reconciler will heal)",
				"oldPath", canonOld, "newPath", canonNew, "err", mvErr)
		}
		return "", fmt.Errorf("notes.MoveFolder(%s→%s): index batch update: %w", canonOld, canonNew, err)
	}

	// Walk the registry and re-prefix every entry under oldPath/.
	s.registry.renamePrefix(canonOld+"/", canonNew+"/")
	return canonNew, nil
}

// ----------------------------------------------------------------------
// Validation helpers (private to package notes).
// ----------------------------------------------------------------------

// validateNoteTitle rejects empty titles, slash characters, control
// characters, leading dots, the literal "..", and the ".md" suffix
// (which the server appends; re-appending would yield "foo.md.md").
// Threat T-03-03-01 mitigation.
func validateNoteTitle(title string) error {
	if title == "" {
		return fmt.Errorf("title is empty")
	}
	if strings.HasSuffix(strings.ToLower(title), ".md") {
		return fmt.Errorf("title must not include the .md suffix")
	}
	return validateBareName(title)
}

// validateFolderName rejects the same set as validateNoteTitle minus
// the .md-suffix rule. Folders may legitimately be named "notes.md" if
// the user wanted, but we keep the conservative rule and reject any
// dot-prefix to avoid hidden directories.
func validateFolderName(name string) error {
	if name == "" {
		return fmt.Errorf("folder name is empty")
	}
	return validateBareName(name)
}

func validateBareName(name string) error {
	if name == "." || name == ".." {
		return fmt.Errorf("name cannot be %q", name)
	}
	if strings.HasPrefix(name, ".") {
		return fmt.Errorf("name cannot start with a dot: %q", name)
	}
	if strings.ContainsAny(name, "/\\") {
		return fmt.Errorf("name contains path separator: %q", name)
	}
	if !utf8.ValidString(name) {
		return fmt.Errorf("name is not valid UTF-8")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return fmt.Errorf("name contains control character")
		}
	}
	return nil
}

// buildNotePath joins parentPath + title, appending ".md" and forcing
// forward slashes. parentPath may be empty (root) or may contain nested
// segments.
func buildNotePath(parentPath, title string) string {
	parent := strings.Trim(parentPath, "/")
	if parent == "" {
		return title + ".md"
	}
	return path.Join(parent, title+".md")
}

// buildFolderPath joins parentPath + name (no extension).
func buildFolderPath(parentPath, name string) string {
	parent := strings.Trim(parentPath, "/")
	if parent == "" {
		return name
	}
	return path.Join(parent, name)
}

// canonicalRelPath normalizes the rel path to the lower-cased forward-
// slash form used throughout the index. Intentionally a thin wrapper
// over strings.ToLower + ToSlash — the heavy lifting (NFC normalization
// + symlink-escape resolution) happens inside fsstore.Canonicalize at
// every FileStore boundary call. This helper is for pieces of code
// that need the canonical key WITHOUT touching the FS (e.g. the index
// upsert path right after a successful CreateFile).
func canonicalRelPath(relPath string) string {
	cleaned := path.Clean(strings.Trim(relPath, "/"))
	return strings.ToLower(cleaned)
}

// deriveTitleFromFilename returns the user-supplied title verbatim. We
// could prettify (replace dashes with spaces, title-case) but the
// project's convention (UI-SPEC + index/title.go) is to use the
// filename minus .md as-is until the user adds an H1. The Phase 2
// extractTitle already returns "filename without .md" as the fallback;
// we mirror that so display is consistent before the user types.
func deriveTitleFromFilename(title string) string {
	return title
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

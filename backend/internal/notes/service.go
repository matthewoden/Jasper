package notes

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/markdown"
)

// Service is the notes domain service. Get reads the file via FileStore;
// Update writes it via FileStore.WriteAtomic.
//
// Canonical save ordering: filesystem FIRST, then Index, then broadcast.
//
// File-FIRST contract: if Index.Upsert fails for a non-collision reason,
// the file is left on disk unchanged and the next Reconcile heals the
// index. The only error class that propagates to the caller is
// ErrCaseCollision, which the API layer maps to 409.
type Service struct {
	files       FileStore
	index       Index
	broadcaster Broadcaster
	registry    *Registry
	log         *slog.Logger
}

// NewService constructs the service. Passing nil for index substitutes a
// nopIndex no-op; passing nil for broadcaster substitutes nopBroadcaster.
// A nil log is replaced with slog.Default().
func NewService(files FileStore, index Index, broadcaster Broadcaster, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	if index == nil {
		index = nopIndex{}
	}
	if broadcaster == nil {
		broadcaster = nopBroadcaster{}
	}
	return &Service{
		files:       files,
		index:       index,
		broadcaster: broadcaster,
		registry:    NewRegistry(),
		log:         log,
	}
}

type nopBroadcaster struct{}

func (nopBroadcaster) Broadcast(_ string, _ any, _ string) {}

// Registry returns the in-memory UUID → relPath registry. Exposed only
// for the composition root: lifecycle.Run calls svc.Registry().Hydrate(summaries)
// after the startup incremental reindex completes, so every indexed note has
// a registry entry before the HTTP listener accepts connections.
//
// Production callers other than lifecycle.Run should NOT use this accessor —
// Service.Get / Update / Create / Delete / Move / *Folder maintain the
// registry internally.
func (s *Service) Registry() *Registry { return s.registry }

// Get returns the Note for the given UUID, or ErrNotFound if the UUID is
// not in the registry or the underlying file is missing on disk.
//
// File-not-found is mapped to ErrNotFound rather than surfaced raw because
// the API layer treats both as a 404 — and the registry "knowing" about a
// UUID does not guarantee the file was seeded yet.
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

// Update writes new content for the given UUID. Filesystem write FIRST;
// Index.Upsert SECOND; Broadcast THIRD.
// Returns the updated Note (or ErrNotFound if the UUID is unknown).
//
// Empty content is allowed; empty markdown is a legal state.
//
// If-Match validation: when ifMatch is non-empty, the file's current mtime
// is compared to the client-supplied value (formatted as RFC3339Nano UTC).
// On mismatch the method returns ErrStaleWrite without touching the file.
// Empty ifMatch is permissive (curl/automation friendly).
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
//     is preserved because the filesystem is the source of truth;
//     the index is recoverable via Reconcile. We do NOT return the error
//     to the caller — a transient SQLite error must not surface as a 500
//     when the user's content is safely on disk.
//   - Broadcast fires ONLY when Upsert succeeded (not on transient
//     index errors) — broadcast after index, never before.
func (s *Service) Update(ctx context.Context, id uuid.UUID, content string, ifMatch string) (Note, error) {
	relPath, ok := s.registry.Lookup(id)
	if !ok {
		return Note{}, fmt.Errorf("notes.Update(%s): %w", id, ErrNotFound)
	}

	if ifMatch != "" {
		currentMTime, statErr := s.files.Stat(relPath)
		if statErr != nil {
			return Note{}, fmt.Errorf("notes.Update(%s): stat for if-match: %w", id, statErr)
		}
		currentMTimeUTC := currentMTime.UTC()
		currentTag := currentMTimeUTC.Format(time.RFC3339Nano)
		if ifMatch != currentTag {
			return Note{}, fmt.Errorf("notes.Update(%s): %w (current=%s, if-match=%s)",
				id, &StaleWriteInfo{Current: currentMTimeUTC}, currentTag, ifMatch)
		}
	}

	if content != "" && !markdown.HasFrontmatter([]byte(content)) {
		content = "---\ntags: []\n---\n\n" + content
	}

	if err := s.files.WriteAtomic(relPath, []byte(content)); err != nil {
		return Note{}, fmt.Errorf("notes.Update(%s): write: %w", id, err)
	}
	modTime, err := s.files.Stat(relPath)
	if err != nil {
		return Note{}, fmt.Errorf("notes.Update(%s): stat after write: %w", id, err)
	}

	freshTitle := markdown.ExtractTitle([]byte(content), relPath)

	tags := markdown.ExtractTags([]byte(content))
	bodyTags := markdown.ExtractBodyTags([]byte(content))
	canonical := unionTags(tags, bodyTags)

	rec := NoteRecord{
		ID:            id,
		Path:          relPath,
		Title:         freshTitle,
		MTimeUnix:     modTime.UTC().Unix(),
		SizeBytes:     int64(len(content)),
		Checksum:      "",
		UpdatedAtUnix: modTime.UTC().Unix(),
		BodyFTS:       markdown.ExtractBodyForFTS([]byte(content)),
		TagNamesFTS:   markdown.JoinTagNamesForFTS(canonical),
	}
	indexSucceeded := false
	if err := s.index.Upsert(ctx, rec); err != nil {
		if errors.Is(err, ErrCaseCollision) {
			return Note{}, fmt.Errorf("notes.Update(%s): %w", id, err)
		}

		s.log.Error(
			"notes.Update: index upsert failed (file is on disk; recoverable via Reconcile)",
			"id", id.String(),
			"path", relPath,
			"err", err,
		)
	} else {
		indexSucceeded = true
	}

	sortedTags := append([]string(nil), tags...)
	sort.Strings(sortedTags)
	if !slices.Equal(canonical, sortedTags) {
		rewritten, rwErr := markdown.RewriteFrontmatterTags([]byte(content), canonical)
		if rwErr != nil {
			s.log.Warn("notes.Update: frontmatter rewriteback parse error (index uses canonical; file unchanged)",
				"id", id.String(), "err", rwErr)
		} else if wErr := s.files.WriteAtomic(relPath, rewritten); wErr != nil {
			s.log.Warn("notes.Update: frontmatter rewriteback write failed (index uses canonical; file may be stale, reconcile heals)",
				"id", id.String(), "err", wErr)
		} else {
			content = string(rewritten)
			if newMTime, statErr := s.files.Stat(relPath); statErr == nil {
				modTime = newMTime
			}
		}
	}

	if err := s.index.SyncTags(ctx, id, canonical); err != nil {
		s.log.Error("notes.Update: tags sync failed (file safe; index heals on reconcile)",
			"id", id.String(), "err", err)
	}

	s.registry.AddRecord(id, relPath, strings.ToLower(freshTitle))

	refs := markdown.ExtractWikilinks([]byte(content))
	if err := s.index.SyncBacklinks(ctx, id, relPath, refs, s.registry, []byte(content)); err != nil {
		s.log.Error("notes.Update: backlinks sync failed (file safe; index heals on reconcile)",
			"id", id.String(), "err", err)
	}

	if indexSucceeded {
		s.broadcaster.Broadcast(EventNoteUpdated, map[string]any{
			"id":         id.String(),
			"path":       relPath,
			"updated_at": modTime.UTC().Format(time.RFC3339Nano),
		}, SessionIDFromContext(ctx))

		s.broadcaster.Broadcast(EventTagsUpdated, map[string]any{
			"note_id": id.String(),
		}, SessionIDFromContext(ctx))
	}

	return Note{
		ID:        id,
		Path:      relPath,
		Content:   content,
		UpdatedAt: modTime.UTC(),
	}, nil
}

// Create creates a new note at <parentPath>/<title>.md. The path is
// canonicalized inside FileStore.CreateFile; collision rejection and
// atomic temp+rename are delegated to the FileStore.
//
// FS-FIRST contract: file is created, then index is upserted, then the
// registry is updated. On Index.Upsert failure AFTER successful file
// creation, the file is deleted in a best-effort cleanup and the index
// error is returned wrapped. The reconciler heals any half-state if the
// cleanup fails.
//
// Create is a thin wrapper around CreateWithBody routing through the
// single-write code path.
func (s *Service) Create(ctx context.Context, parentPath, title string) (NoteSummary, error) {
	return s.CreateWithBody(ctx, parentPath, title, "")
}

// CreateWithBodyAndTitle creates a new note at <parentPath>/<title>.md with
// an optional human-friendly display title used for the scaffold H1. When
// displayTitle == "", the scaffold's H1 falls back to the filename-derived
// title (same as CreateWithBody).
//
// displayTitle is sanitized at the call site to strip newlines + control
// chars + collapse whitespace.
func (s *Service) CreateWithBodyAndTitle(ctx context.Context, parentPath, title, body, displayTitle string) (NoteSummary, error) {
	return s.createInternal(ctx, parentPath, title, body, displayTitle)
}

// CreateWithBody creates a new note at <parentPath>/<title>.md, optionally
// pre-populating it with the supplied body. Composes (scaffold + body) IN
// MEMORY and writes it in one atomic operation.
//
// body == "" produces the canonical NewNoteContent(title) scaffold.
//
// body != "" appends the body BYTES VERBATIM after the scaffold, so the
// caller's content is preserved exactly as supplied — no server-side
// massaging beyond the scaffold prefix.
//
// Single updated_at, single WS broadcast, single index Upsert.
func (s *Service) CreateWithBody(ctx context.Context, parentPath, title, body string) (NoteSummary, error) {
	return s.createInternal(ctx, parentPath, title, body, "")
}

func (s *Service) createInternal(ctx context.Context, parentPath, title, body, displayTitleOverride string) (NoteSummary, error) {
	if err := validateNoteTitle(title); err != nil {
		return NoteSummary{}, fmt.Errorf("notes.Create: %w", err)
	}
	relPath := buildNotePath(parentPath, title)

	if err := s.files.CreateFile(relPath); err != nil {
		return NoteSummary{}, fmt.Errorf("notes.Create(%s): %w", relPath, err)
	}

	displayTitle := deriveTitleFromFilename(title)
	if displayTitleOverride != "" {
		displayTitle = displayTitleOverride
	}
	scaffold := markdown.NewNoteContent(displayTitle)
	var scaffoldContent []byte
	if body == "" {
		scaffoldContent = scaffold
	} else {
		scaffoldContent = make([]byte, 0, len(scaffold)+len(body))
		scaffoldContent = append(scaffoldContent, scaffold...)
		scaffoldContent = append(scaffoldContent, body...)
	}
	canonPath := canonicalRelPath(relPath)
	if err := s.files.WriteAtomic(canonPath, scaffoldContent); err != nil {
		if delErr := s.files.DeleteFile(relPath); delErr != nil {
			s.log.Warn("notes.Create: rollback DeleteFile failed after scaffold write error (reconciler will heal)",
				"path", relPath, "err", delErr)
		}
		return NoteSummary{}, fmt.Errorf("notes.Create(%s): scaffold write: %w", relPath, err)
	}

	id := uuid.New()
	now := time.Now().UTC()

	scaffoldTags := markdown.ExtractTags(scaffoldContent)
	scaffoldBodyTags := markdown.ExtractBodyTags(scaffoldContent)
	createCanonical := unionTags(scaffoldTags, scaffoldBodyTags)

	rec := NoteRecord{
		ID:            id,
		Path:          canonPath,
		Title:         displayTitle,
		MTimeUnix:     now.Unix(),
		SizeBytes:     int64(len(scaffoldContent)),
		Checksum:      "",
		UpdatedAtUnix: now.Unix(),
		BodyFTS:       markdown.ExtractBodyForFTS(scaffoldContent),
		TagNamesFTS:   markdown.JoinTagNamesForFTS(createCanonical),
	}
	if err := s.index.Upsert(ctx, rec); err != nil {
		if delErr := s.files.DeleteFile(relPath); delErr != nil {
			s.log.Warn("notes.Create: rollback DeleteFile failed (reconciler will heal)",
				"path", relPath, "err", delErr)
		}
		return NoteSummary{}, fmt.Errorf("notes.Create(%s): index upsert: %w", relPath, err)
	}

	s.registry.AddRecord(id, rec.Path, strings.ToLower(rec.Title))

	sortedScaffoldTags := append([]string(nil), scaffoldTags...)
	sort.Strings(sortedScaffoldTags)
	if !slices.Equal(createCanonical, sortedScaffoldTags) {
		if rewritten, rwErr := markdown.RewriteFrontmatterTags(scaffoldContent, createCanonical); rwErr == nil {
			if wErr := s.files.WriteAtomic(canonPath, rewritten); wErr != nil {
				s.log.Warn("notes.Create: frontmatter rewriteback write failed (index uses canonical; file may be stale, reconcile heals)",
					"path", canonPath, "err", wErr)
			}
		} else {
			s.log.Warn("notes.Create: frontmatter rewriteback parse error (index uses canonical; file unchanged)",
				"path", canonPath, "err", rwErr)
		}
	}
	if err := s.index.SyncTags(ctx, id, createCanonical); err != nil {
		s.log.Error("notes.Create: tags sync failed (file safe; index heals on reconcile)",
			"path", canonPath, "err", err)
	}

	s.broadcaster.Broadcast(EventNoteCreated, map[string]any{
		"id":         id.String(),
		"path":       rec.Path,
		"title":      rec.Title,
		"updated_at": now.UTC().Format(time.RFC3339Nano),
	}, SessionIDFromContext(ctx))

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

	// FS-FIRST (PROJECT file-FIRST contract): move the note into .trash/ BEFORE
	// touching the index. If TrashFile fails, the index and registry are left
	// untouched — there is nothing to roll back. If the later index.Delete fails,
	// the reconciler heals on next startup (WalkVault skips .trash/, so the
	// trashed file is not re-adopted as a live note).
	if _, err := s.files.TrashFile(relPath); err != nil {
		return fmt.Errorf("notes.Delete(%s): %w", id, err)
	}

	if err := s.index.Delete(ctx, id); err != nil {
		s.log.Warn("notes.Delete: index delete failed after FS-trash (reconciler will heal on next startup)",
			"id", id.String(), "path", relPath, "err", err)
		return fmt.Errorf("notes.Delete(%s): index delete: %w", id, err)
	}
	s.registry.Remove(id)

	s.broadcaster.Broadcast(EventNoteDeleted, map[string]any{
		"id":   id.String(),
		"path": relPath,
	}, SessionIDFromContext(ctx))

	return nil
}

// Move renames a note. FS-FIRST: rename the file, then UPDATE the index
// row's path inside a fresh Upsert, then update the registry. On
// Index.Upsert failure AFTER successful FS rename, the file is moved
// back (best-effort).
//
// The new path is canonicalized inside FileStore.MoveFile.
//
// After the FS rename succeeds, the file's content is re-read and the
// title is re-extracted (markdown.ExtractTitle — the same scanner the
// indexer uses) so the index row's Title reflects the current first-H1
// (or filename fallback).
//
// A read failure post-rename is non-fatal: a warn log is emitted and
// the filename fallback is used. The reconciler heals at the next pass.
func (s *Service) Move(ctx context.Context, id uuid.UUID, newPath string) (NoteSummary, error) {
	oldRelPath, ok := s.registry.Lookup(id)
	if !ok {
		return NoteSummary{}, fmt.Errorf("notes.Move(%s): %w", id, ErrNotFound)
	}
	canonNew := canonicalRelPath(newPath)

	if err := s.files.MoveFile(oldRelPath, canonNew); err != nil {
		return NoteSummary{}, fmt.Errorf("notes.Move(%s): %w", id, err)
	}

	modTime, statErr := s.files.Stat(canonNew)
	if statErr != nil {
		if mvErr := s.files.MoveFile(canonNew, oldRelPath); mvErr != nil {
			s.log.Warn("notes.Move: rollback MoveFile failed after stat error (reconciler will heal)",
				"id", id.String(), "oldPath", oldRelPath, "newPath", canonNew, "err", mvErr)
		}
		return NoteSummary{}, fmt.Errorf("notes.Move(%s): stat after rename: %w", id, statErr)
	}
	postMoveMTime := modTime.UTC()

	content, readErr := s.files.Read(canonNew)
	if readErr != nil {
		s.log.Warn("notes.Move: post-rename Read failed; using filename fallback for title (reconciler will heal)",
			"id", id.String(), "newPath", canonNew, "err", readErr)
		content = nil
	}
	freshTitle := markdown.ExtractTitle(content, canonNew)

	rec, err := s.index.LookupByPath(ctx, oldRelPath)
	if err != nil {
		rec = NoteRecord{
			ID:            id,
			Path:          canonNew,
			Title:         freshTitle,
			MTimeUnix:     postMoveMTime.Unix(),
			UpdatedAtUnix: postMoveMTime.Unix(),
		}
		// Belt-and-suspenders: LookupByPath failed (index row missing/stale),
		// so there is no old BodyFTS to carry forward. If the post-rename
		// Read succeeded, derive it fresh so a move never wipes body search.
		if content != nil {
			rec.BodyFTS = markdown.ExtractBodyForFTS(content)
			rec.TagNamesFTS = markdown.JoinTagNamesForFTS(unionTags(markdown.ExtractTags(content), markdown.ExtractBodyTags(content)))
		}
	} else {
		rec.Path = canonNew
		rec.Title = freshTitle
		rec.MTimeUnix = postMoveMTime.Unix()
		rec.UpdatedAtUnix = postMoveMTime.Unix()
	}

	if err := s.index.Upsert(ctx, rec); err != nil {
		if mvErr := s.files.MoveFile(canonNew, oldRelPath); mvErr != nil {
			s.log.Warn("notes.Move: rollback MoveFile failed (reconciler will heal)",
				"id", id.String(), "oldPath", oldRelPath, "newPath", canonNew, "err", mvErr)
		}
		return NoteSummary{}, fmt.Errorf("notes.Move(%s): index upsert: %w", id, err)
	}
	s.registry.Rename(id, canonNew)

	s.broadcaster.Broadcast(EventNoteMoved, map[string]any{
		"id":         id.String(),
		"old_path":   oldRelPath,
		"new_path":   canonNew,
		"updated_at": postMoveMTime.Format(time.RFC3339Nano),
		"title":      rec.Title,
	}, SessionIDFromContext(ctx))

	return NoteSummary{
		ID:        id,
		Path:      canonNew,
		Title:     rec.Title,
		UpdatedAt: postMoveMTime,
	}, nil
}

// CreateFolder creates an empty directory at <parentPath>/<name>.
// Folders have no SQLite identity — the index is over .md files only —
// so this is pure FS work. Returns the canonical relpath of the new
// folder.
func (s *Service) CreateFolder(ctx context.Context, parentPath, name string) (string, error) {
	if err := validateFolderName(name); err != nil {
		return "", fmt.Errorf("notes.CreateFolder: %w", err)
	}
	relPath := buildFolderPath(parentPath, name)
	if err := s.files.CreateDir(relPath); err != nil {
		return "", fmt.Errorf("notes.CreateFolder(%s): %w", relPath, err)
	}
	canon := canonicalRelPath(relPath)

	s.broadcaster.Broadcast(EventFolderCreated, map[string]any{
		"path": canon,
		"name": name,
	}, SessionIDFromContext(ctx))

	return canon, nil
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

	// Phase 14 (A4 soft-delete): TrashDir moves the whole subtree into .trash/
	// regardless of the recursive flag, so both paths must purge the index and
	// registry for every note under the folder — otherwise trashed notes linger
	// in GET /notes, the tree, and search until the next reconcile (TRASH-03).
	doomedIDs := s.registry.idsUnder(canon)

	// MCP delete_note (mcp/tools.go:443) inherits soft-delete via Service.Delete.
	if _, err := s.files.TrashDir(folderPath); err != nil {
		return fmt.Errorf("notes.DeleteFolder(%s): %w", canon, err)
	}
	if _, err := s.index.DeleteByPathPrefix(ctx, canon); err != nil {
		s.log.Warn("notes.DeleteFolder: index batch-delete failed (RECONCILER WILL HEAL on next startup)",
			"path", canon, "err", err)
		return fmt.Errorf("notes.DeleteFolder(%s): index delete: %w", canon, err)
	}
	for _, id := range doomedIDs {
		s.registry.Remove(id)
	}

	s.broadcaster.Broadcast(EventFolderDeleted, map[string]any{
		"path":      canon,
		"recursive": recursive,
	}, SessionIDFromContext(ctx))

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
		if mvErr := s.files.MoveDir(newPath, oldPath); mvErr != nil {
			s.log.Warn("notes.MoveFolder: rollback MoveDir failed (reconciler will heal)",
				"oldPath", canonOld, "newPath", canonNew, "err", mvErr)
		}
		return "", fmt.Errorf("notes.MoveFolder(%s→%s): index batch update: %w", canonOld, canonNew, err)
	}

	s.registry.renamePrefix(canonOld+"/", canonNew+"/")

	s.broadcaster.Broadcast(EventFolderMoved, map[string]any{
		"old_path": canonOld,
		"new_path": canonNew,
	}, SessionIDFromContext(ctx))

	return canonNew, nil
}

func validateNoteTitle(title string) error {
	if title == "" {
		return fmt.Errorf("title is empty: %w", ErrInvalidContent)
	}
	if strings.HasSuffix(strings.ToLower(title), ".md") {
		return fmt.Errorf("title must not include the .md suffix: %w", ErrInvalidContent)
	}
	return validateBareName(title)
}

func validateFolderName(name string) error {
	if name == "" {
		return fmt.Errorf("folder name is empty: %w", ErrInvalidContent)
	}
	return validateBareName(name)
}

func validateBareName(name string) error {
	if name == "." || name == ".." {
		return fmt.Errorf("name cannot be %q: %w", name, ErrInvalidContent)
	}
	if strings.HasPrefix(name, ".") {
		return fmt.Errorf("name cannot start with a dot: %q: %w", name, ErrInvalidContent)
	}
	if strings.ContainsAny(name, "/\\") {
		return fmt.Errorf("name contains path separator: %q: %w", name, ErrInvalidContent)
	}
	if !utf8.ValidString(name) {
		return fmt.Errorf("name is not valid UTF-8: %w", ErrInvalidContent)
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return fmt.Errorf("name contains control character: %w", ErrInvalidContent)
		}
	}
	return nil
}

func buildNotePath(parentPath, title string) string {
	parent := strings.Trim(parentPath, "/")
	if parent == "" {
		return title + ".md"
	}
	return path.Join(parent, title+".md")
}

func buildFolderPath(parentPath, name string) string {
	parent := strings.Trim(parentPath, "/")
	if parent == "" {
		return name
	}
	return path.Join(parent, name)
}

func canonicalRelPath(relPath string) string {
	cleaned := path.Clean(strings.Trim(relPath, "/"))
	return strings.ToLower(cleaned)
}

func deriveTitleFromFilename(title string) string {
	return title
}

// LookupTitle is the public form of lookupTitle for use by API handlers.
// Returns "" when the id is unknown so the caller can short-circuit.
func (s *Service) LookupTitle(id uuid.UUID) string {
	relPath, ok := s.registry.Lookup(id)
	if !ok {
		return ""
	}
	return strings.TrimSuffix(path.Base(relPath), ".md")
}

// LookupSummary returns a lightweight NoteSummary for id populated from the
// registry (for use by the PostNoteMove handler to capture the pre-move
// state and post-rollback state without a DB round-trip).
// Returns a zero NoteSummary and false if the id is not in the registry.
func (s *Service) LookupSummary(id uuid.UUID) (NoteSummary, bool) {
	relPath, ok := s.registry.Lookup(id)
	if !ok {
		return NoteSummary{}, false
	}
	return NoteSummary{
		ID:    id,
		Path:  relPath,
		Title: strings.TrimSuffix(path.Base(relPath), ".md"),
	}, true
}

var validTagRE = regexp.MustCompile(`^[a-z0-9_-]+$`)

func isValidTagName(s string) bool { return validTagRE.MatchString(s) }

func uuidsToStrings(ids []uuid.UUID) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = id.String()
	}
	return out
}

// RenameTagAcrossVault renames a tag from oldName to newName in every carrier
// note's YAML frontmatter. Two-phase atomicity: FS pass first, SQL pass
// second (non-fatal), broadcast third.
//
// Returns the UUIDs of all affected notes, or:
//   - ErrTagNotFound if oldName has no carriers (empty index result).
//   - ErrInvalidTagName if newName violates the allowed charset ([a-z0-9_-]+).
//   - ErrTagCollision if newName collides with an existing tag (propagated
//     from index.RenameTag).
//
// Rollback on FS failure: if any WriteAtomic call fails, every
// already-written file is restored to its pre-state via a best-effort
// WriteAtomic pass.
func (s *Service) RenameTagAcrossVault(ctx context.Context, oldName, newName string) ([]uuid.UUID, error) {
	if !isValidTagName(newName) {
		return nil, fmt.Errorf("notes.RenameTagAcrossVault: %w", ErrInvalidTagName)
	}

	carriers, err := s.index.NotesByTag(ctx, oldName)
	if err != nil {
		return nil, fmt.Errorf("notes.RenameTagAcrossVault: NotesByTag: %w", err)
	}
	if len(carriers) == 0 {
		return nil, fmt.Errorf("notes.RenameTagAcrossVault: %w", ErrTagNotFound)
	}

	type fileState struct {
		path    string
		before  []byte
		rewrite []byte
	}
	states := make([]fileState, 0, len(carriers))
	for _, c := range carriers {
		before, readErr := s.files.Read(c.Path)
		if readErr != nil {
			return nil, fmt.Errorf("notes.RenameTagAcrossVault: read %s: %w", c.Path, readErr)
		}
		rewrite := rewriteTagsArray(before, oldName, newName)
		states = append(states, fileState{path: c.Path, before: before, rewrite: rewrite})
	}

	written := make([]int, 0, len(states))
	for i, st := range states {
		if err := s.files.WriteAtomic(st.path, st.rewrite); err != nil {
			for _, wi := range written {
				if rbErr := s.files.WriteAtomic(states[wi].path, states[wi].before); rbErr != nil {
					s.log.Error("RenameTagAcrossVault: rollback WriteAtomic failed (reconciler will heal)",
						"path", states[wi].path, "err", rbErr)
				}
			}
			return nil, fmt.Errorf("notes.RenameTagAcrossVault: write %s: %w", st.path, err)
		}
		written = append(written, i)
	}

	if _, sqlErr := s.index.RenameTag(ctx, oldName, newName); sqlErr != nil {
		if errors.Is(sqlErr, ErrTagCollision) || errors.Is(sqlErr, ErrTagNotFound) {
			return nil, fmt.Errorf("notes.RenameTagAcrossVault: index rename: %w", sqlErr)
		}
		s.log.Error("RenameTagAcrossVault: SQL pass failed (FS is truth; reconcile heals)",
			"old", oldName, "new", newName, "err", sqlErr)
	}

	touchedIDs := make([]uuid.UUID, len(carriers))
	for i, c := range carriers {
		touchedIDs[i] = c.ID
	}
	sort.Slice(touchedIDs, func(i, j int) bool {
		return touchedIDs[i].String() < touchedIDs[j].String()
	})

	s.broadcaster.Broadcast(EventTagsRewritten, map[string]any{
		"old_name":         oldName,
		"new_name":         newName,
		"touched_note_ids": uuidsToStrings(touchedIDs),
	}, SessionIDFromContext(ctx))

	return touchedIDs, nil
}

// DeleteTagAcrossVault removes a tag from every carrier note's YAML frontmatter.
// Structurally identical to RenameTagAcrossVault except the tag is deleted
// (rewriteTagsArray with newName="") and index.DeleteTag is called.
// The broadcast payload uses new_name=nil.
func (s *Service) DeleteTagAcrossVault(ctx context.Context, name string) ([]uuid.UUID, error) {
	carriers, err := s.index.NotesByTag(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("notes.DeleteTagAcrossVault: NotesByTag: %w", err)
	}
	if len(carriers) == 0 {
		return nil, fmt.Errorf("notes.DeleteTagAcrossVault: %w", ErrTagNotFound)
	}

	type fileState struct {
		path    string
		before  []byte
		rewrite []byte
	}
	states := make([]fileState, 0, len(carriers))
	for _, c := range carriers {
		before, readErr := s.files.Read(c.Path)
		if readErr != nil {
			return nil, fmt.Errorf("notes.DeleteTagAcrossVault: read %s: %w", c.Path, readErr)
		}
		rewrite := rewriteTagsArray(before, name, "")
		states = append(states, fileState{path: c.Path, before: before, rewrite: rewrite})
	}

	written := make([]int, 0, len(states))
	for i, st := range states {
		if err := s.files.WriteAtomic(st.path, st.rewrite); err != nil {
			for _, wi := range written {
				if rbErr := s.files.WriteAtomic(states[wi].path, states[wi].before); rbErr != nil {
					s.log.Error("DeleteTagAcrossVault: rollback WriteAtomic failed",
						"path", states[wi].path, "err", rbErr)
				}
			}
			return nil, fmt.Errorf("notes.DeleteTagAcrossVault: write %s: %w", st.path, err)
		}
		written = append(written, i)
	}

	if _, sqlErr := s.index.DeleteTag(ctx, name); sqlErr != nil && !errors.Is(sqlErr, ErrTagNotFound) {
		s.log.Error("DeleteTagAcrossVault: SQL pass failed (FS is truth; reconcile heals)",
			"name", name, "err", sqlErr)
	}

	touchedIDs := make([]uuid.UUID, len(carriers))
	for i, c := range carriers {
		touchedIDs[i] = c.ID
	}
	sort.Slice(touchedIDs, func(i, j int) bool {
		return touchedIDs[i].String() < touchedIDs[j].String()
	})

	s.broadcaster.Broadcast(EventTagsRewritten, map[string]any{
		"old_name":         name,
		"new_name":         nil,
		"touched_note_ids": uuidsToStrings(touchedIDs),
	}, SessionIDFromContext(ctx))

	return touchedIDs, nil
}

// RenameRewriteWikilinks rewrites every [[OldTitle]] and [[OldTitle|alias]]
// reference to [[NewTitle]] / [[NewTitle|alias]] across the vault. Two-phase
// atomicity: FS pass first, SQL pass second (non-fatal), broadcast third.
//
// Only INBOUND references are rewritten — the renamed note's own [[...]] links
// are not touched here (they are updated on next Save via SyncBacklinks).
//
// Returns the UUIDs of all touched referrer notes, or an empty slice when
// there are no referrers (no broadcast fired in that case).
//
// Rollback on FS failure: every already-written file is restored.
func (s *Service) RenameRewriteWikilinks(ctx context.Context, oldTitle, newTitle string) ([]uuid.UUID, error) {
	referrers, err := s.index.SourcesByBacklinkTitle(ctx, oldTitle)
	if err != nil {
		return nil, fmt.Errorf("notes.RenameRewriteWikilinks: SourcesByBacklinkTitle: %w", err)
	}
	if len(referrers) == 0 {
		return []uuid.UUID{}, nil
	}

	type fileState struct {
		id      uuid.UUID
		path    string
		before  []byte
		rewrite []byte
	}
	states := make([]fileState, 0, len(referrers))
	for _, r := range referrers {
		before, readErr := s.files.Read(r.Path)
		if readErr != nil {
			return nil, fmt.Errorf("notes.RenameRewriteWikilinks: read %s: %w", r.Path, readErr)
		}
		rewrite := RewriteWikilinksAST(before, oldTitle, newTitle)
		states = append(states, fileState{id: r.ID, path: r.Path, before: before, rewrite: rewrite})
	}

	if os.Getenv("JASPER_TEST_FAIL_REWRITE") == "1" {
		return []uuid.UUID{}, fmt.Errorf("JASPER_TEST_FAIL_REWRITE: simulated rewrite failure")
	}

	written := make([]int, 0, len(states))
	for i, st := range states {
		if err := s.files.WriteAtomic(st.path, st.rewrite); err != nil {
			for _, wi := range written {
				if rbErr := s.files.WriteAtomic(states[wi].path, states[wi].before); rbErr != nil {
					s.log.Error("RenameRewriteWikilinks: rollback WriteAtomic failed",
						"path", states[wi].path, "err", rbErr)
				}
			}
			return nil, fmt.Errorf("notes.RenameRewriteWikilinks: write %s: %w", st.path, err)
		}
		written = append(written, i)
	}

	if sqlErr := s.index.UpdateBacklinksTargetTitle(ctx, oldTitle, newTitle, nil); sqlErr != nil {
		s.log.Error("RenameRewriteWikilinks: SQL backlinks update failed (FS is truth; reconcile heals)",
			"old", oldTitle, "new", newTitle, "err", sqlErr)
	}

	touchedIDs := make([]uuid.UUID, len(states))
	for i, st := range states {
		touchedIDs[i] = st.id
	}
	sort.Slice(touchedIDs, func(i, j int) bool {
		return touchedIDs[i].String() < touchedIDs[j].String()
	})

	s.broadcaster.Broadcast(EventLinksRewritten, map[string]any{
		"old_title":        oldTitle,
		"new_title":        newTitle,
		"touched_note_ids": uuidsToStrings(touchedIDs),
	}, SessionIDFromContext(ctx))

	return touchedIDs, nil
}

type nopIndex struct{}

func (nopIndex) Upsert(_ context.Context, _ NoteRecord) error  { return nil }
func (nopIndex) Delete(_ context.Context, _ uuid.UUID) error   { return nil }
func (nopIndex) List(_ context.Context) ([]NoteSummary, error) { return nil, nil }

// nopIndex no-ops for path-mutation methods. A misconfigured caller gets a
// quiet failure mode rather than a panic; the reconciler heals any state.
func (nopIndex) LookupByPath(_ context.Context, _ string) (NoteRecord, error) {
	return NoteRecord{}, ErrNotFound
}
func (nopIndex) MovePathPrefix(_ context.Context, _, _ string) (int, error)  { return 0, nil }
func (nopIndex) DeleteByPathPrefix(_ context.Context, _ string) (int, error) { return 0, nil }

// nopIndex no-ops for tag + backlink sync. These are the fallbacks used
// by nil-index callers (tests that don't wire a real indexer).
func (nopIndex) ListTags(_ context.Context) ([]TagWithCount, error)        { return []TagWithCount{}, nil }
func (nopIndex) SyncTags(_ context.Context, _ uuid.UUID, _ []string) error { return nil }

func (nopIndex) SyncBacklinks(_ context.Context, _ uuid.UUID, _ string,
	_ []markdown.WikiLinkRef, _ *Registry, _ []byte,
) error {
	return nil
}

// nopIndex no-ops for cross-vault rewrite methods.
func (nopIndex) NotesByTag(_ context.Context, _ string) ([]NoteSummary, error) {
	return []NoteSummary{}, nil
}
func (nopIndex) RenameTag(_ context.Context, _, _ string) ([]uuid.UUID, error) { return nil, nil }
func (nopIndex) DeleteTag(_ context.Context, _ string) ([]uuid.UUID, error)    { return nil, nil }
func (nopIndex) SourcesByBacklinkTitle(_ context.Context, _ string) ([]NoteSummary, error) {
	return []NoteSummary{}, nil
}

func (nopIndex) UpdateBacklinksTargetTitle(_ context.Context, _, _ string, _ *uuid.UUID) error {
	return nil
}

// nopIndex no-ops for GetBacklinks + SearchTitles.
func (nopIndex) GetBacklinks(_ context.Context, _ uuid.UUID) ([]BacklinkRow, error) {
	return []BacklinkRow{}, nil
}

func (nopIndex) SearchTitles(_ context.Context, _ string, _ int) ([]SearchResult, error) {
	return []SearchResult{}, nil
}

// nopIndex no-op for SearchFTS.
func (nopIndex) SearchFTS(_ context.Context, _ string, _ string, _ int) ([]SearchHit, error) {
	return []SearchHit{}, nil
}

func unionTags(a, b []string) []string {
	seen := make(map[string]struct{}, len(a)+len(b))
	out := make([]string, 0, len(a)+len(b))
	for _, t := range append(a, b...) {
		if _, ok := seen[t]; !ok {
			seen[t] = struct{}{}
			out = append(out, t)
		}
	}
	sort.Strings(out)
	return out
}

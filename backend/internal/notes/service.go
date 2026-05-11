package notes

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/markdown"
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
	files       FileStore
	index       Index
	broadcaster Broadcaster
	registry    *Registry
	log         *slog.Logger
}

// NewService constructs the service. The index parameter is required
// in production (Plan 02-06's composition root passes a real
// *index.Indexer); callers may pass nil and Service substitutes a
// nopIndex no-op so Phase 1 tests and any callers that don't need the
// derived index continue to work unchanged.
//
// The broadcaster parameter is the Phase 4 WebSocket hub port. Pass nil
// and Service substitutes nopBroadcaster so existing callers compile and
// pass without wiring the hub. Plan 04-04's composition root always
// passes a real *wshub.Hub.
//
// A nil log is replaced with slog.Default() so callers don't have to
// thread a logger through every test.
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

// nopBroadcaster mirrors nopIndex. Used when callers pass nil — Phase
// 1/2/3 tests don't wire the hub and continue to compile + pass.
type nopBroadcaster struct{}

func (nopBroadcaster) Broadcast(_ string, _ any, _ string) {}

// Registry returns the in-memory UUID → relPath registry. Exposed
// ONLY for the composition root in Plan 03-04: lifecycle.Run calls
// svc.Registry().Hydrate(summaries) after the startup incremental
// reindex completes, so every indexed note has a registry entry
// before the HTTP listener accepts connections (DESIGN.md §6.1
// listener gating preserved).
//
// Production callers other than lifecycle.Run should NOT use this
// accessor — Service.Get / Update / Create / Delete / Move / *Folder
// maintain the registry internally.
func (s *Service) Registry() *Registry { return s.registry }

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
// per ARCHITECTURE.md §11.1; Index.Upsert SECOND; Broadcast THIRD.
// Returns the updated Note (or ErrNotFound if the UUID is unknown).
//
// Empty content is allowed (Phase 1 has a textarea — empty markdown is
// a legal state).
//
// If-Match validation (SYNC-06): when ifMatch is non-empty, the file's
// current mtime is compared to the client-supplied value (formatted as
// RFC3339Nano UTC). On mismatch the method returns ErrStaleWrite without
// touching the file. Empty ifMatch is permissive (curl/automation friendly).
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
//   - Broadcast fires ONLY when Upsert succeeded (not on transient
//     index errors). Pitfall 2: broadcast after index, never before.
func (s *Service) Update(ctx context.Context, id uuid.UUID, content string, ifMatch string) (Note, error) {
	relPath, ok := s.registry.Lookup(id)
	if !ok {
		return Note{}, fmt.Errorf("notes.Update(%s): %w", id, ErrNotFound)
	}

	// SYNC-06 If-Match validation. Empty == permissive (curl/automation).
	if ifMatch != "" {
		currentMTime, statErr := s.files.Stat(relPath)
		if statErr != nil {
			return Note{}, fmt.Errorf("notes.Update(%s): stat for if-match: %w", id, statErr)
		}
		currentMTimeUTC := currentMTime.UTC()
		currentTag := currentMTimeUTC.Format(time.RFC3339Nano)
		if ifMatch != currentTag {
			// BL-02: surface the same Stat result that produced the
			// mismatch verdict via a typed error so the API handler can
			// build current_updated_at without a second filesystem Stat
			// (which would race a third writer between the two calls).
			// errors.Is(err, ErrStaleWrite) keeps working via Unwrap.
			return Note{}, fmt.Errorf("notes.Update(%s): %w (current=%s, if-match=%s)",
				id, &StaleWriteInfo{Current: currentMTimeUTC}, currentTag, ifMatch)
		}
	}

	// D-10 (TAGS-EXT-02): auto-restore frontmatter scaffold when missing.
	// This is the only system-side mutation of user content during normal
	// operation (D-11 one-time migration is a separate startup step).
	// Per D-10: prepend ONLY the YAML block ("---\ntags: []\n---\n\n"),
	// NOT the H1 — the user's body content (which may already have an H1)
	// is left intact. InjectFrontmatterScaffold includes the H1, which is
	// for new notes (D-09). Here we want the minimal YAML fence only.
	// Empty content gets no injection (empty markdown is a legal state).
	if content != "" && !markdown.HasFrontmatter([]byte(content)) {
		content = "---\ntags: []\n---\n\n" + content
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
	//
	// Plan 03-23 (Gap R2-6 closure cohort): re-extract the title from the
	// just-written content so the index row's Title field reflects the
	// CURRENT H1 (or filename fallback for files without an H1). Mirrors
	// Plan 03-21's Service.Move title-refresh — the same property
	// (Title-current-after-write) is required of Service.Update for
	// Direction A of the filename↔H1 binding (PROJECT.md 2026-05-03):
	// without this, after a Move-then-Update sequence the Move-derived
	// title would be clobbered by Title="" on the subsequent Update,
	// leaving the tree label stale until the next Reconcile pass.
	freshTitle := markdown.ExtractTitle([]byte(content), relPath)
	rec := NoteRecord{
		ID:            id,
		Path:          relPath,
		Title:         freshTitle,
		MTimeUnix:     modTime.UTC().Unix(),
		SizeBytes:     int64(len(content)),
		Checksum:      "", // Phase 7 only
		UpdatedAtUnix: modTime.UTC().Unix(),
	}
	indexSucceeded := false
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
	} else {
		indexSucceeded = true
	}

	// Phase 6 Step A: parse frontmatter tags (non-fatal per D-12).
	// File-FIRST: even if tag sync fails, the user's content is on disk.
	tags := markdown.ExtractTags([]byte(content))

	// Phase 6 Step B: sync tags in a single transaction. Non-fatal — file is
	// truth. If the index is a nopIndex this is also a no-op.
	if err := s.index.SyncTags(ctx, id, tags); err != nil {
		s.log.Error("notes.Update: tags sync failed (file safe; index heals on reconcile)",
			"id", id.String(), "err", err)
	}

	// Phase 6 Step C: parse wiki-links and sync backlinks in a single TX.
	refs := markdown.ExtractWikilinks([]byte(content))
	if err := s.index.SyncBacklinks(ctx, id, relPath, refs, s.registry, []byte(content)); err != nil {
		s.log.Error("notes.Update: backlinks sync failed (file safe; index heals on reconcile)",
			"id", id.String(), "err", err)
	}

	// BROADCAST — THIRD step per ARCHITECTURE.md §11.1. Only after
	// Index.Upsert succeeded. Pitfall 2: if Index.Upsert returned a
	// transient error (logged-and-swallowed above), do NOT broadcast.
	// T-04-04: payload contains ONLY metadata — no content field.
	if indexSucceeded {
		s.broadcaster.Broadcast(EventNoteUpdated, map[string]any{
			"id":         id.String(),
			"path":       relPath,
			"updated_at": modTime.UTC().Format(time.RFC3339Nano),
		}, SessionIDFromContext(ctx))
		// Phase 6 Step D: also broadcast EventTagsUpdated so the tag browser
		// can refresh reactively (D-34). Fired alongside EventNoteUpdated.
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

	// D-09 (TAGS-EXT-01): write the canonical frontmatter scaffold so the
	// new note ships with `---\ntags: []\n---\n\n# {Title}\n`. Every create
	// path MUST call this so the scaffold is uniform vault-wide. The title
	// is derived from the filename (without .md) per Phase 3 R2.
	displayTitle := deriveTitleFromFilename(title)
	scaffoldContent := markdown.NewNoteContent(displayTitle)
	canonPath := canonicalRelPath(relPath)
	if err := s.files.WriteAtomic(canonPath, scaffoldContent); err != nil {
		// Best-effort rollback on scaffold write failure.
		if delErr := s.files.DeleteFile(relPath); delErr != nil {
			s.log.Warn("notes.Create: rollback DeleteFile failed after scaffold write error (reconciler will heal)",
				"path", relPath, "err", delErr)
		}
		return NoteSummary{}, fmt.Errorf("notes.Create(%s): scaffold write: %w", relPath, err)
	}

	id := uuid.New()
	now := time.Now().UTC()
	rec := NoteRecord{
		ID:            id,
		Path:          canonPath,
		Title:         displayTitle,
		MTimeUnix:     now.Unix(),
		SizeBytes:     int64(len(scaffoldContent)),
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

	// BROADCAST — THIRD step. Only after successful Upsert. T-04-04: no content.
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

	// BROADCAST — THIRD step. After successful FS-delete + registry remove.
	// Path captured BEFORE deletion (relPath snapshot). T-04-04: no content.
	s.broadcaster.Broadcast(EventNoteDeleted, map[string]any{
		"id":   id.String(),
		"path": relPath,
	}, SessionIDFromContext(ctx))

	return nil
}

// Move renames a note. FS-FIRST: rename the file, then UPDATE the index
// row's path inside a fresh Upsert (which carries the same UUID +
// existing fields, only Path changes), then update the registry. On
// Index.Upsert failure AFTER successful FS rename, the file is moved
// back (best-effort).
//
// The new path is canonicalized inside FileStore.MoveFile per DATA-11.
//
// After the FS rename succeeds, the file's content is re-read and the
// title is re-extracted (markdown.ExtractTitle — the same scanner the
// indexer uses) so the index row's Title field reflects the current
// first-H1 (or filename fallback) for the renamed file. Gap R2-6
// closure (Plan 03-21).
//
// A read failure post-rename is non-fatal: a warn log is emitted and
// the filename fallback is used (markdown.ExtractTitle handles nil
// content by returning the filename without ".md"). The reconciler
// heals at the next pass if the read failure was transient.
func (s *Service) Move(ctx context.Context, id uuid.UUID, newPath string) (NoteSummary, error) {
	oldRelPath, ok := s.registry.Lookup(id)
	if !ok {
		return NoteSummary{}, fmt.Errorf("notes.Move(%s): %w", id, ErrNotFound)
	}
	canonNew := canonicalRelPath(newPath)

	if err := s.files.MoveFile(oldRelPath, canonNew); err != nil {
		return NoteSummary{}, fmt.Errorf("notes.Move(%s): %w", id, err)
	}

	// BL-01 — stat the file AFTER rename so the broadcast `updated_at`
	// reflects the post-rename mtime (nanosecond precision) rather than
	// the stale mtime captured at index time. The fresh modTime is the
	// single source of truth for both rec.MTimeUnix and the wire payload;
	// per the OpenAPI spec (api/openapi.yaml WSNoteMovedPayload) the
	// `updated_at` field is the post-move file mtime.
	modTime, statErr := s.files.Stat(canonNew)
	if statErr != nil {
		// Best-effort rollback — the rename succeeded but we cannot
		// observe the new mtime, so the broadcast/index would carry an
		// inconsistent timestamp. Surface to the caller; the reconciler
		// heals on the next pass.
		if mvErr := s.files.MoveFile(canonNew, oldRelPath); mvErr != nil {
			s.log.Warn("notes.Move: rollback MoveFile failed after stat error (reconciler will heal)",
				"id", id.String(), "oldPath", oldRelPath, "newPath", canonNew, "err", mvErr)
		}
		return NoteSummary{}, fmt.Errorf("notes.Move(%s): stat after rename: %w", id, statErr)
	}
	postMoveMTime := modTime.UTC()

	// Gap R2-6 — re-extract title from the renamed file's content so
	// the tree row label refreshes on the next GET /tree. Read failure
	// is non-fatal: surface a warn log + use the filename fallback so
	// the reconciler can heal at its next pass.
	content, readErr := s.files.Read(canonNew)
	if readErr != nil {
		s.log.Warn("notes.Move: post-rename Read failed; using filename fallback for title (reconciler will heal)",
			"id", id.String(), "newPath", canonNew, "err", readErr)
		content = nil // markdown.ExtractTitle handles nil → filename fallback
	}
	freshTitle := markdown.ExtractTitle(content, canonNew)

	// Capture existing record from the index so we preserve size while
	// updating the path + title + mtime. LookupByPath uses the OLD path
	// (the row hasn't been touched yet).
	rec, err := s.index.LookupByPath(ctx, oldRelPath)
	if err != nil {
		// The FS rename succeeded but the index has no row — most
		// likely a transient state during reconcile. Mint a fresh
		// minimal record so the index gets re-populated; the
		// reconciler will heal size later.
		rec = NoteRecord{
			ID:            id,
			Path:          canonNew,
			Title:         freshTitle,
			MTimeUnix:     postMoveMTime.Unix(),
			UpdatedAtUnix: postMoveMTime.Unix(),
		}
	} else {
		rec.Path = canonNew
		rec.Title = freshTitle
		rec.MTimeUnix = postMoveMTime.Unix()
		rec.UpdatedAtUnix = postMoveMTime.Unix()
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

	// BROADCAST — THIRD step. After successful index upsert + registry rename.
	// T-04-04: no content. BL-01: use the post-rename Stat result so the
	// wire payload's nanosecond-precision mtime matches the file's actual
	// mtime — receivers comparing this against their cached `updated_at`
	// must see a fresh value. WR-06: include title so receiving tabs can
	// refresh the tree-row label without a follow-up GET /tree round-trip
	// (the schema marks title required as of WR-06).
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

	// BROADCAST — after successful FS create. Folders have no index row so
	// "THIRD" here means "after the only operation (FS create)".
	// T-04-04: no content.
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
	if !recursive {
		if err := s.files.DeleteDir(folderPath, false); err != nil {
			return fmt.Errorf("notes.DeleteFolder(%s): %w", canon, err)
		}

		// BROADCAST — after successful empty-dir delete.
		s.broadcaster.Broadcast(EventFolderDeleted, map[string]any{
			"path":      canon,
			"recursive": false,
		}, SessionIDFromContext(ctx))

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

	// BROADCAST — after successful recursive delete + index cleanup.
	s.broadcaster.Broadcast(EventFolderDeleted, map[string]any{
		"path":      canon,
		"recursive": true,
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
		// Best-effort FS rollback.
		if mvErr := s.files.MoveDir(newPath, oldPath); mvErr != nil {
			s.log.Warn("notes.MoveFolder: rollback MoveDir failed (reconciler will heal)",
				"oldPath", canonOld, "newPath", canonNew, "err", mvErr)
		}
		return "", fmt.Errorf("notes.MoveFolder(%s→%s): index batch update: %w", canonOld, canonNew, err)
	}

	// Walk the registry and re-prefix every entry under oldPath/.
	s.registry.renamePrefix(canonOld+"/", canonNew+"/")

	// BROADCAST — THIRD step. After successful index batch update + registry rename.
	// T-04-04: no content.
	s.broadcaster.Broadcast(EventFolderMoved, map[string]any{
		"old_path": canonOld,
		"new_path": canonNew,
	}, SessionIDFromContext(ctx))

	return canonNew, nil
}

// ----------------------------------------------------------------------
// Validation helpers (private to package notes).
// ----------------------------------------------------------------------

// validateNoteTitle rejects empty titles, slash characters, control
// characters, leading dots, the literal "..", and the ".md" suffix
// (which the server appends; re-appending would yield "foo.md.md").
// Threat T-03-03-01 mitigation.
//
// Returned errors wrap ErrInvalidContent so the API layer (Plan 03-04)
// can map every validation failure to 400 invalid_request via
// errors.Is, keeping validation errors distinct from internal 500s.
func validateNoteTitle(title string) error {
	if title == "" {
		return fmt.Errorf("title is empty: %w", ErrInvalidContent)
	}
	if strings.HasSuffix(strings.ToLower(title), ".md") {
		return fmt.Errorf("title must not include the .md suffix: %w", ErrInvalidContent)
	}
	return validateBareName(title)
}

// validateFolderName rejects the same set as validateNoteTitle minus
// the .md-suffix rule. Folders may legitimately be named "notes.md" if
// the user wanted, but we keep the conservative rule and reject any
// dot-prefix to avoid hidden directories.
//
// Returned errors wrap ErrInvalidContent so callers can use errors.Is.
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

// ---------------------------------------------------------------------------
// Phase 6 Plan 06-05 Task 3: cross-vault rewrite methods
// ---------------------------------------------------------------------------

// validTagRE defines the D-22 charset for tag names: lowercase letters,
// digits, hyphens, underscores only.
var validTagRE = regexp.MustCompile(`^[a-z0-9_-]+$`)

// isValidTagName reports whether s satisfies the D-22 charset rule.
func isValidTagName(s string) bool { return validTagRE.MatchString(s) }

// uuidsToStrings converts a UUID slice to a string slice for WS payloads.
func uuidsToStrings(ids []uuid.UUID) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = id.String()
	}
	return out
}

// RenameTagAcrossVault renames a tag from oldName to newName in every carrier
// note's YAML frontmatter. Two-phase D-37 atomicity: FS pass first, SQL pass
// second (non-fatal), broadcast third.
//
// Returns the UUIDs of all affected notes, or:
//   - ErrTagNotFound if oldName has no carriers (empty index result).
//   - ErrInvalidTagName if newName violates D-22 charset.
//   - ErrTagCollision if newName collides with an existing tag (propagated
//     from index.RenameTag).
//
// Rollback on FS failure (D-37): if any WriteAtomic call fails, every
// already-written file is restored to its pre-state via a best-effort
// WriteAtomic pass.
func (s *Service) RenameTagAcrossVault(ctx context.Context, oldName, newName string) ([]uuid.UUID, error) {
	if !isValidTagName(newName) {
		return nil, fmt.Errorf("notes.RenameTagAcrossVault: %w", ErrInvalidTagName)
	}

	// 1. Find carrier notes via the index.
	carriers, err := s.index.NotesByTag(ctx, oldName)
	if err != nil {
		return nil, fmt.Errorf("notes.RenameTagAcrossVault: NotesByTag: %w", err)
	}
	if len(carriers) == 0 {
		return nil, fmt.Errorf("notes.RenameTagAcrossVault: %w", ErrTagNotFound)
	}

	// 2. Capture pre-state for all carrier notes.
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

	// 3. FS pass — write each rewritten file atomically. On any failure,
	// restore all already-written files (D-37 rollback).
	written := make([]int, 0, len(states))
	for i, st := range states {
		if err := s.files.WriteAtomic(st.path, st.rewrite); err != nil {
			// Rollback: restore all files written so far.
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

	// 4. SQL pass — single-transaction rename. Non-fatal: FS is truth.
	if _, sqlErr := s.index.RenameTag(ctx, oldName, newName); sqlErr != nil {
		// Check for semantic errors that the caller cares about.
		if errors.Is(sqlErr, ErrTagCollision) || errors.Is(sqlErr, ErrTagNotFound) {
			return nil, fmt.Errorf("notes.RenameTagAcrossVault: index rename: %w", sqlErr)
		}
		s.log.Error("RenameTagAcrossVault: SQL pass failed (FS is truth; reconcile heals)",
			"old", oldName, "new", newName, "err", sqlErr)
	}

	// 5. Build the touched IDs slice (deterministic order for broadcast).
	touchedIDs := make([]uuid.UUID, len(carriers))
	for i, c := range carriers {
		touchedIDs[i] = c.ID
	}
	sort.Slice(touchedIDs, func(i, j int) bool {
		return touchedIDs[i].String() < touchedIDs[j].String()
	})

	// 6. Broadcast (D-34): EventTagsRewritten with origin session ID.
	s.broadcaster.Broadcast(EventTagsRewritten, map[string]any{
		"old_name":         oldName,
		"new_name":         newName,
		"touched_note_ids": uuidsToStrings(touchedIDs),
	}, SessionIDFromContext(ctx))

	return touchedIDs, nil
}

// DeleteTagAcrossVault removes a tag from every carrier note's YAML frontmatter.
// Structurally identical to RenameTagAcrossVault except step 3 deletes the tag
// (rewriteTagsArray with newName="") and step 4 calls index.DeleteTag.
// The broadcast payload uses new_name=nil (D-34 delete semantics).
func (s *Service) DeleteTagAcrossVault(ctx context.Context, name string) ([]uuid.UUID, error) {
	// 1. Find carrier notes.
	carriers, err := s.index.NotesByTag(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("notes.DeleteTagAcrossVault: NotesByTag: %w", err)
	}
	if len(carriers) == 0 {
		return nil, fmt.Errorf("notes.DeleteTagAcrossVault: %w", ErrTagNotFound)
	}

	// 2. Capture pre-state and build rewrites (newName="" = delete).
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

	// 3. FS pass with D-37 rollback on failure.
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

	// 4. SQL pass — non-fatal. ErrTagNotFound is a race (already deleted); treat as success.
	if _, sqlErr := s.index.DeleteTag(ctx, name); sqlErr != nil && !errors.Is(sqlErr, ErrTagNotFound) {
		s.log.Error("DeleteTagAcrossVault: SQL pass failed (FS is truth; reconcile heals)",
			"name", name, "err", sqlErr)
	}

	// 5. Touched IDs (deterministic order).
	touchedIDs := make([]uuid.UUID, len(carriers))
	for i, c := range carriers {
		touchedIDs[i] = c.ID
	}
	sort.Slice(touchedIDs, func(i, j int) bool {
		return touchedIDs[i].String() < touchedIDs[j].String()
	})

	// 6. Broadcast — new_name is nil for delete semantics (D-34).
	s.broadcaster.Broadcast(EventTagsRewritten, map[string]any{
		"old_name":         name,
		"new_name":         nil,
		"touched_note_ids": uuidsToStrings(touchedIDs),
	}, SessionIDFromContext(ctx))

	return touchedIDs, nil
}

// RenameRewriteWikilinks rewrites every [[OldTitle]] and [[OldTitle|alias]]
// reference to [[NewTitle]] / [[NewTitle|alias]] across the vault. Two-phase
// D-36 atomicity: FS pass first, SQL pass second (non-fatal), broadcast third.
//
// Only INBOUND references are rewritten — the renamed note's own [[...]] links
// are not touched here (they are updated on next Save via SyncBacklinks).
//
// Returns the UUIDs of all touched referrer notes, or an empty slice when
// there are no referrers (no broadcast fired in that case — Test RW2).
//
// Rollback on FS failure (D-36): every already-written file is restored.
func (s *Service) RenameRewriteWikilinks(ctx context.Context, oldTitle, newTitle string) ([]uuid.UUID, error) {
	// 1. Find referrer notes that contain [[OldTitle]].
	referrers, err := s.index.SourcesByBacklinkTitle(ctx, oldTitle)
	if err != nil {
		return nil, fmt.Errorf("notes.RenameRewriteWikilinks: SourcesByBacklinkTitle: %w", err)
	}
	if len(referrers) == 0 {
		return []uuid.UUID{}, nil // nothing to do; no broadcast
	}

	// 2. Capture pre-state and build rewrites via the AST-based rewriter.
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

	// 3. FS pass with D-36 rollback on failure.
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

	// 4. SQL pass — update backlinks table. Non-fatal: FS is truth.
	// Direct UPDATE is simpler and atomic; the next save of any referrer
	// re-syncs backlinks fully via SyncBacklinks.
	if sqlErr := s.index.UpdateBacklinksTargetTitle(ctx, oldTitle, newTitle, nil); sqlErr != nil {
		s.log.Error("RenameRewriteWikilinks: SQL backlinks update failed (FS is truth; reconcile heals)",
			"old", oldTitle, "new", newTitle, "err", sqlErr)
	}

	// 5. Collect touched IDs (deterministic order).
	touchedIDs := make([]uuid.UUID, len(states))
	for i, st := range states {
		touchedIDs[i] = st.id
	}
	sort.Slice(touchedIDs, func(i, j int) bool {
		return touchedIDs[i].String() < touchedIDs[j].String()
	})

	// 6. Broadcast EventLinksRewritten (D-33) — only when touched is non-empty.
	s.broadcaster.Broadcast(EventLinksRewritten, map[string]any{
		"old_title":        oldTitle,
		"new_title":        newTitle,
		"touched_note_ids": uuidsToStrings(touchedIDs),
	}, SessionIDFromContext(ctx))

	return touchedIDs, nil
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
func (nopIndex) MovePathPrefix(_ context.Context, _, _ string) (int, error)  { return 0, nil }
func (nopIndex) DeleteByPathPrefix(_ context.Context, _ string) (int, error) { return 0, nil }

// Phase 6 Plan 06-05 additions — nopIndex no-ops for tag + backlink sync.
// Plan 06-05 wires the real implementations; these are the fallbacks used
// by nil-index callers (Phase 1 tests, httptest-based unit tests, etc.).
func (nopIndex) ListTags(_ context.Context) ([]TagWithCount, error)        { return []TagWithCount{}, nil }
func (nopIndex) SyncTags(_ context.Context, _ uuid.UUID, _ []string) error { return nil }

func (nopIndex) SyncBacklinks(_ context.Context, _ uuid.UUID, _ string,
	_ []markdown.WikiLinkRef, _ *Registry, _ []byte,
) error {
	return nil
}

// Phase 6 Plan 06-05 Task 3 additions — cross-vault rewrite nopIndex stubs.
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

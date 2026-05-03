// Package index is the SQLite-backed implementation of notes.Index.
// It is the single derived projection of every .md file under
// <DataDir>/notes — the filesystem is the source of truth (DATA-01)
// and Reconcile is what makes "wiping the database is never data loss"
// hold (DESIGN.md §4.4).
//
// Plan boundary: Plan 02-04a landed the SKELETON only — the package
// structure, the type declarations, the constructor, the Mode enum,
// the extractTitle helper, and method signatures with no-op bodies.
// Plan 02-04b (this plan) lands the real bodies:
//
//   - walk.go: WalkVault filesystem traversal (FileMeta yield).
//   - store.go: Upsert / Delete / List / existing — SQLite CRUD against
//     the `notes` table; ErrCaseCollision (DATA-12) on UNIQUE-constraint.
//   - reconcile.go: Reconcile body — incremental (mtime-only per
//     DATA-09 partial; checksum fallback DEFERRED to Phase 7) + full.
//   - chooseID (this file): ScratchpadUUID compatibility helper.
package index

import (
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Mode is the kind of Reconcile pass to run.
//
//   - ModeIncremental: compare on-disk mtimes to the indexed mtime_unix
//     and only re-read files whose mtime has changed (DATA-09 partial —
//     mtime-only, checksum fallback deferred to Phase 7). This is the
//     steady-state startup path and the cheap admin/reindex hot path.
//   - ModeFull: re-read every file unconditionally and re-extract title
//     / size. This is what Path 2 (RebuildAndReindex,
//     migrate.Runner.Path2Rebuild) calls into via Reconcile(ctx,
//     ModeFull) — the migration runner truncated the `notes` table
//     before invoking us.
type Mode string

const (
	ModeIncremental Mode = "incremental"
	ModeFull        Mode = "full"
)

// Indexer is the concrete *notes.Index implementation backed by SQLite.
//
// Pair holds the writer/reader split from internal/db/sqlite (Plan
// 02-01). Upsert and Delete go through Pair.BeginImmediate; List goes
// through Pair.Reader. NotesDir is the absolute path to <DataDir>/notes
// — the root the filesystem walk in Reconcile (walk.go) scans.
//
// nowUnix is an injectable clock so tests can pin index-touch times.
type Indexer struct {
	Pair     *sqlite.Pair
	NotesDir string // absolute path to <DataDir>/notes
	Log      *slog.Logger

	nowUnix func() int64
}

// New constructs an Indexer. Production callers (Plan 02-06's
// composition root) pass the *sqlite.Pair returned by sqlite.Open and
// the absolute path filepath.Join(cfg.DataDir, "notes"). A nil log is
// replaced with slog.Default() so tests don't have to thread a logger.
func New(pair *sqlite.Pair, notesDir string, log *slog.Logger) *Indexer {
	if log == nil {
		log = slog.Default()
	}
	return &Indexer{
		Pair:     pair,
		NotesDir: notesDir,
		Log:      log,
		nowUnix:  func() int64 { return time.Now().Unix() },
	}
}

// Compile-time assertion: *Indexer satisfies notes.Index. This catches
// any drift between the port and the implementation at build time.
// The methods Upsert / Delete / List live in store.go; Reconcile
// (which is NOT part of the notes.Index port) lives in reconcile.go.
var _ notes.Index = (*Indexer)(nil)

// chooseID returns the existing-row id when present; otherwise the
// ScratchpadUUID for the seeded scratchpad path; otherwise a fresh v4
// UUID. Plan 02-06's smoke test depends on the scratchpad keeping its
// hard-coded UUID through Reconcile (Phase 1 frontend still calls
// GET /api/v1/notes/{ScratchpadUUID}).
//
// The special-case ONLY fires when relPath == notes.ScratchpadRelPath
// AND existingID == uuid.Nil (no row exists for that path yet) —
// T-02-04b-07 mitigation. The constants are package-private to notes,
// so this special-case cannot be abused to claim arbitrary UUIDs.
func chooseID(existingID uuid.UUID, relPath string) uuid.UUID {
	if existingID != uuid.Nil {
		return existingID
	}
	if relPath == notes.ScratchpadRelPath {
		return notes.ScratchpadUUID
	}
	return uuid.New()
}

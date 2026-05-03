// Package index is the SQLite-backed implementation of notes.Index.
// It is the single derived projection of every .md file under
// <DataDir>/notes — the filesystem is the source of truth (DATA-01)
// and Reconcile is what makes "wiping the database is never data loss"
// hold (DESIGN.md §4.4).
//
// Plan boundary: Plan 02-04a lands the SKELETON only — the package
// structure, the type declarations, the constructor, the Mode enum,
// the extractTitle helper, and the four method signatures
// (Reconcile / Upsert / Delete / List) with no-op bodies that allow
// the rest of the codebase to compile against the type. Plan 02-04b
// replaces the bodies with the real walk + store + reconcile logic and
// adds the 5,000-note stress test that backs ROADMAP success criterion #5.
package index

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Mode is the kind of Reconcile pass to run.
//
//   - ModeIncremental: compare on-disk mtimes to the indexed mtime_unix
//     and only re-read files whose mtime has changed (DATA-09).
//     This is the steady-state startup path and the post-/admin/reindex
//     hot path.
//   - ModeFull: drop nothing, but re-read every file unconditionally
//     and re-extract title/size. This is what Path 2 (RebuildAndReindex,
//     migrate.Runner.Path2Rebuild) calls into via this package's
//     Reconcile(ctx, ModeFull) — the migration runner truncated the
//     `notes` table itself before invoking us.
//
// The body of Reconcile lands in Plan 02-04b.
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
// — the root the filesystem walk in Reconcile (Plan 02-04b's walk.go)
// scans.
//
// nowUnix is an injectable clock so tests can pin index-touch times
// (Plan 02-04b uses this; this plan's skeleton only exposes the field).
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
// Plan 02-04b replaces the no-op bodies below with real implementations
// without changing the method signatures or this assertion.
var _ notes.Index = (*Indexer)(nil)

// Reconcile walks NotesDir, compares each .md file's mtime to the
// indexed row, and inserts/updates/deletes index rows so the index
// matches the filesystem. Returns the number of indexed notes after
// reconciliation.
//
// Mode controls the comparison strategy (see Mode docs).
//
// SKELETON: the body lands in Plan 02-04b. Returning a sentinel error
// here means any caller that wires up Reconcile before 02-04b lands
// fails loudly rather than silently succeeding with zero work done.
// migrate.Runner.Path2Rebuild is wired by Plan 02-04b's app.New, NOT
// by this plan, so the production codepath does not yet reach this
// method.
func (x *Indexer) Reconcile(ctx context.Context, mode Mode) (int, error) {
	_ = ctx
	_ = mode
	return 0, fmt.Errorf("indexer: Reconcile body lands in Plan 02-04b")
}

// Upsert inserts or updates the index row for rec. Plan 02-04a wires
// this method into notes.Service.Update via the notes.Index port; the
// real INSERT ... ON CONFLICT(path) DO UPDATE statement (and the
// ErrCaseCollision detection on UNIQUE-constraint violation) lands in
// Plan 02-04b's store.go.
//
// SKELETON: returns nil so notes.Service.Update succeeds end-to-end in
// integration tests that wire a real *Indexer before 02-04b lands.
// This means Upsert silently no-ops in 02-04a; the file is still
// written (file-FIRST). Plan 02-04b's store.go body replaces this with
// the real implementation; tests for the body live in 02-04b.
func (x *Indexer) Upsert(ctx context.Context, rec notes.NoteRecord) error {
	_ = ctx
	_ = rec
	return nil
}

// Delete removes the index row for the given UUID. Idempotent: a
// missing row is not an error (file-deletes can race with the indexer
// scan).
//
// SKELETON: body lands in Plan 02-04b. Returns nil so callers compile.
func (x *Indexer) Delete(ctx context.Context, id uuid.UUID) error {
	_ = ctx
	_ = id
	return nil
}

// List returns a NoteSummary per indexed note for the file-tree /
// notes-list UI. Order is undefined at the port level.
//
// SKELETON: body lands in Plan 02-04b. Returns (nil, nil) — an empty
// list, NOT an error — so the GetNotes handler skeleton in
// handlers_stubs.go (which 02-04b replaces) keeps working through this
// transition.
func (x *Indexer) List(ctx context.Context) ([]notes.NoteSummary, error) {
	_ = ctx
	return nil, nil
}

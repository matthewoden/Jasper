// Package index is the SQLite-backed implementation of notes.Index.
// It is the single derived projection of every .md file under
// <DataDir>/notes — the filesystem is the source of truth and Reconcile
// is what makes "wiping the database is never data loss" hold.
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
//     and only re-read files whose mtime has changed. This is the
//     steady-state startup path and the cheap admin/reindex hot path.
//   - ModeFull: re-read every file unconditionally and re-extract title
//     / size. Used by full rebuild paths where the `notes` table has
//     been truncated before invoking the reconciler.
type Mode string

// Index reconcile modes — incremental processes only changed paths since
// the last index write; full forces a complete rescan.
const (
	ModeIncremental Mode = "incremental"
	ModeFull        Mode = "full"
)

// Indexer is the concrete *notes.Index implementation backed by SQLite.
// Upsert and Delete go through Pair.BeginImmediate; List goes through
// Pair.Reader. NotesDir is the absolute path to <DataDir>/notes —
// the root the filesystem walk in Reconcile (walk.go) scans.
// nowUnix is an injectable clock so tests can pin index-touch times.
type Indexer struct {
	Pair     *sqlite.Pair
	NotesDir string // absolute path to <DataDir>/notes
	Log      *slog.Logger

	nowUnix func() int64
}

// New constructs an Indexer. Pass the *sqlite.Pair returned by
// sqlite.Open and the absolute path filepath.Join(cfg.DataDir, "notes").
// A nil log is replaced with slog.Default() so tests don't have to
// thread a logger.
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

var _ notes.Index = (*Indexer)(nil)

func chooseID(existingID uuid.UUID, relPath string) uuid.UUID {
	if existingID != uuid.Nil {
		return existingID
	}
	if relPath == notes.ScratchpadRelPath {
		return notes.ScratchpadUUID
	}
	return uuid.New()
}

// Package index — FTS5 index population helpers.
//
// checkAndRepairFTSDivergence detects and auto-repairs notes/notes_fts
// row-count divergence at startup.
//
// ExtractBodyForFTS / JoinTagNamesForFTS live in internal/markdown (a leaf
// package) so internal/notes can populate NoteRecord.BodyFTS / TagNamesFTS
// on the interactive save paths without importing this adapter package.
package index

import (
	"context"
	"fmt"
)

func (x *Indexer) checkAndRepairFTSDivergence(ctx context.Context) error {
	var notesCount, ftsCount int
	if err := x.Pair.Reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes`).Scan(&notesCount); err != nil {
		return fmt.Errorf("fts divergence check (notes count): %w", err)
	}
	if err := x.Pair.Reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts`).Scan(&ftsCount); err != nil {
		return fmt.Errorf("fts divergence check (fts count): %w", err)
	}

	rowsDiverge := notesCount != ftsCount

	contentStale := false
	if notesCount > 0 {
		var populated int
		if err := x.Pair.Reader.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM notes WHERE body_fts != ''`).Scan(&populated); err != nil {
			return fmt.Errorf("fts divergence check (populated count): %w", err)
		}

		contentStale = populated == 0
	}

	if !rowsDiverge && !contentStale {
		return nil
	}

	if rowsDiverge {
		x.Log.Warn("FTS5 row-count divergence detected; rebuilding",
			"notes", notesCount, "fts", ftsCount)
	} else {
		x.Log.Warn("FTS5 content stale (all body_fts empty); rebuilding",
			"notes", notesCount)
	}

	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return fmt.Errorf("fts rebuild begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`); err != nil {
		return fmt.Errorf("fts rebuild: %w", err)
	}
	return tx.Commit()
}

package index

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Reconcile dispatches to reconcileIncremental / reconcileFull. This is
// the public API consumed by the lifecycle (startup re-index per
// DATA-09) and by api.Server.PostAdminReindex (DATA-10).
//
// Returns the count of indexed notes after the reconciliation completes
// (post-deletes for incremental; total upserted for full).
func (x *Indexer) Reconcile(ctx context.Context, mode Mode) (int, error) {
	switch mode {
	case ModeFull:
		return x.reconcileFull(ctx)
	case ModeIncremental:
		return x.reconcileIncremental(ctx)
	default:
		return 0, fmt.Errorf("indexer: unknown mode %q", mode)
	}
}

// reconcileIncremental scans the filesystem, compares each file's mtime
// against the index, and upserts only those that have moved forward
// (DATA-09 mtime-first, partial). Files missing from disk that exist
// in the index are deleted.
//
// mtime-first is fast but can miss content-only changes that don't
// bump mtime (rare on macOS APFS / WSL ext4 — mtime resolution is 1
// second so concurrent writes within the same second can race).
//
// CHECKSUM FALLBACK IS DEFERRED TO PHASE 7. Phase 2 ships mtime-only.
// See "Deferred from this phase" section in 02-04b-PLAN.md and
// REQUIREMENTS.md DATA-09 row.
func (x *Indexer) reconcileIncremental(ctx context.Context) (int, error) {
	existing, err := x.existing(ctx)
	if err != nil {
		return 0, fmt.Errorf("reconcile incremental: load existing: %w", err)
	}
	seen := make(map[string]bool, len(existing))

	walkErr := WalkVault(ctx, x.NotesDir, func(fm FileMeta) error {
		seen[fm.CanonicalRelPath] = true
		cur, ok := existing[fm.CanonicalRelPath]

		// Skip if mtime unchanged AND a row already exists for that path.
		// This is the cheap fast-path that makes startup re-index O(N)
		// stat calls only — no file reads, no SQL writes.
		if ok && cur.MTime == fm.MTimeUnix {
			return nil
		}

		// Decide ID: reuse existing if present, scratchpad-special, else
		// mint v4. T-02-04b-07: chooseID guards the special-case.
		existingID := uuid.Nil
		if ok {
			existingID = cur.ID
		}
		id := chooseID(existingID, fm.CanonicalRelPath)

		// Read content for title extraction. The indexer is best-effort:
		// a transient read failure is logged and skipped (the file may
		// have been deleted between Walk and ReadFile).
		content, err := os.ReadFile(fm.AbsPath)
		if err != nil {
			x.Log.Warn("indexer: read failed; skipping",
				"path", fm.CanonicalRelPath, "err", err)
			return nil
		}

		rec := notes.NoteRecord{
			ID:            id,
			Path:          fm.CanonicalRelPath,
			Title:         ExtractTitle(content, fm.CanonicalRelPath),
			MTimeUnix:     fm.MTimeUnix,
			SizeBytes:     fm.Size,
			Checksum:      "", // DATA-09 checksum fallback deferred to Phase 7
			UpdatedAtUnix: x.nowUnix(),
		}
		if err := x.Upsert(ctx, rec); err != nil {
			if errors.Is(err, notes.ErrCaseCollision) {
				// DATA-12: log + skip. The first writer's row stays
				// authoritative; the second is rejected as a collision.
				x.Log.Warn("indexer: case collision; skipping",
					"path", fm.CanonicalRelPath, "err", err)
				return nil
			}
			return fmt.Errorf("upsert %s: %w", fm.CanonicalRelPath, err)
		}
		return nil
	})
	if walkErr != nil {
		return 0, fmt.Errorf("reconcile incremental: walk: %w", walkErr)
	}

	// Delete rows whose files are gone.
	for relPath, row := range existing {
		if seen[relPath] {
			continue
		}
		if err := x.Delete(ctx, row.ID); err != nil {
			return 0, fmt.Errorf("reconcile incremental: delete %s: %w", relPath, err)
		}
	}

	// Final count = current row count (post-deletes).
	var n int
	if err := x.Pair.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM notes`).Scan(&n); err != nil {
		return 0, fmt.Errorf("reconcile incremental: count: %w", err)
	}
	return n, nil
}

// reconcileFull walks the entire vault and upserts every file. It does
// NOT delete absent rows because Path 2 (RebuildAndReindex) is expected
// to drop the table before calling reconcileFull, so there are no
// stale rows. If reconcileFull is called WITHOUT a prior drop, leftover
// rows persist (the caller is responsible).
func (x *Indexer) reconcileFull(ctx context.Context) (int, error) {
	upserts := 0
	walkErr := WalkVault(ctx, x.NotesDir, func(fm FileMeta) error {
		content, err := os.ReadFile(fm.AbsPath)
		if err != nil {
			x.Log.Warn("indexer: read failed in full reindex; skipping",
				"path", fm.CanonicalRelPath, "err", err)
			return nil
		}
		// Full reindex uses chooseID with no existing row — only the
		// scratchpad special-case fires; everything else mints a fresh
		// v4 UUID. (Path 2 dropped the table, so there are no existing
		// ids to reuse.)
		id := chooseID(uuid.Nil, fm.CanonicalRelPath)
		rec := notes.NoteRecord{
			ID:            id,
			Path:          fm.CanonicalRelPath,
			Title:         ExtractTitle(content, fm.CanonicalRelPath),
			MTimeUnix:     fm.MTimeUnix,
			SizeBytes:     fm.Size,
			Checksum:      "", // DATA-09 checksum fallback deferred to Phase 7
			UpdatedAtUnix: x.nowUnix(),
		}
		if err := x.Upsert(ctx, rec); err != nil {
			if errors.Is(err, notes.ErrCaseCollision) {
				x.Log.Warn("indexer: case collision in full reindex; skipping",
					"path", fm.CanonicalRelPath, "err", err)
				return nil
			}
			return fmt.Errorf("upsert %s: %w", fm.CanonicalRelPath, err)
		}
		upserts++
		return nil
	})
	if walkErr != nil {
		return upserts, fmt.Errorf("reconcile full: walk: %w", walkErr)
	}
	return upserts, nil
}

package index

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Reconcile dispatches to reconcileIncremental / reconcileFull. This is
// the public API consumed by the lifecycle (startup re-index per
// DATA-09) and by api.Server.PostAdminReindex (DATA-10).
//
// Returns the count of indexed notes after the reconciliation completes
// (post-deletes for incremental; total upserted for full).
//
// Reconcile is a thin wrapper over ReconcileWithRegistry that passes nil
// for the registry — all wiki-link targets are treated as pending in that
// case. Plan 06-06's composition root calls ReconcileWithRegistry directly.
func (x *Indexer) Reconcile(ctx context.Context, mode Mode) (int, error) {
	return x.ReconcileWithRegistry(ctx, mode, nil)
}

// ReconcileWithRegistry extends the base Reconcile with Phase 6 derived-data
// sync: per-file tag extraction (SyncTags) and wiki-link extraction
// (SyncBacklinks) are called after each successful Upsert. Both operations
// are non-fatal per the file-first contract — errors are logged and the
// per-file walk continues.
//
// registry is the title→note registry used for D-20 ambiguity resolution in
// SyncBacklinks. Pass nil to treat every wiki-link target as pending (safe —
// pending rows are updated when the registry is available).
//
// Plan 06-06 wires the real registry at the composition root.
func (x *Indexer) ReconcileWithRegistry(ctx context.Context, mode Mode, registry *notes.Registry) (int, error) {
	var (
		n   int
		err error
	)
	switch mode {
	case ModeFull:
		n, err = x.reconcileFullWithRegistry(ctx, registry)
	case ModeIncremental:
		n, err = x.reconcileIncrementalWithRegistry(ctx, registry)
	default:
		return 0, fmt.Errorf("indexer: unknown mode %q", mode)
	}

	if repairErr := x.checkAndRepairFTSDivergence(ctx); repairErr != nil {
		x.Log.Error("FTS5 divergence repair failed (non-fatal)", "err", repairErr)
	}
	return n, err
}

func (x *Indexer) reconcileIncrementalWithRegistry(ctx context.Context, registry *notes.Registry) (int, error) {
	existing, err := x.existing(ctx)
	if err != nil {
		return 0, fmt.Errorf("reconcile incremental: load existing: %w", err)
	}
	seen := make(map[string]bool, len(existing))

	walkErr := WalkVault(ctx, x.NotesDir, func(fm FileMeta) error {
		seen[fm.CanonicalRelPath] = true
		cur, ok := existing[fm.CanonicalRelPath]

		if ok && cur.MTime == fm.MTimeUnix {
			return nil
		}

		existingID := uuid.Nil
		if ok {
			existingID = cur.ID
		}
		id := chooseID(existingID, fm.CanonicalRelPath)

		content, err := os.ReadFile(fm.AbsPath)
		if err != nil {
			x.Log.Warn("indexer: read failed; skipping",
				"path", fm.CanonicalRelPath, "err", err)
			return nil
		}

		tags := markdown.ExtractTags(content)

		rec := notes.NoteRecord{
			ID:            id,
			Path:          fm.CanonicalRelPath,
			Title:         ExtractTitle(content, fm.CanonicalRelPath),
			MTimeUnix:     fm.MTimeUnix,
			SizeBytes:     fm.Size,
			Checksum:      "",
			UpdatedAtUnix: x.nowUnix(),

			BodyFTS:     ExtractBodyForFTS(content),
			TagNamesFTS: JoinTagNamesForFTS(tags),
		}
		if err := x.Upsert(ctx, rec); err != nil {
			if errors.Is(err, notes.ErrCaseCollision) {
				x.Log.Warn("indexer: case collision; skipping",
					"path", fm.CanonicalRelPath, "err", err)
				return nil
			}
			return fmt.Errorf("upsert %s: %w", fm.CanonicalRelPath, err)
		}

		x.syncDerivedDataWithTags(ctx, rec.ID, rec.Path, content, tags, registry)
		return nil
	})
	if walkErr != nil {
		return 0, fmt.Errorf("reconcile incremental: walk: %w", walkErr)
	}

	for relPath, row := range existing {
		if seen[relPath] {
			continue
		}
		if err := x.Delete(ctx, row.ID); err != nil {
			return 0, fmt.Errorf("reconcile incremental: delete %s: %w", relPath, err)
		}
	}

	var n int
	if err := x.Pair.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM notes`).Scan(&n); err != nil {
		return 0, fmt.Errorf("reconcile incremental: count: %w", err)
	}
	return n, nil
}

func (x *Indexer) reconcileFullWithRegistry(ctx context.Context, registry *notes.Registry) (int, error) {
	upserts := 0
	walkErr := WalkVault(ctx, x.NotesDir, func(fm FileMeta) error {
		content, err := os.ReadFile(fm.AbsPath)
		if err != nil {
			x.Log.Warn("indexer: read failed in full reindex; skipping",
				"path", fm.CanonicalRelPath, "err", err)
			return nil
		}

		tags := markdown.ExtractTags(content)

		id := chooseID(uuid.Nil, fm.CanonicalRelPath)
		rec := notes.NoteRecord{
			ID:            id,
			Path:          fm.CanonicalRelPath,
			Title:         ExtractTitle(content, fm.CanonicalRelPath),
			MTimeUnix:     fm.MTimeUnix,
			SizeBytes:     fm.Size,
			Checksum:      "",
			UpdatedAtUnix: x.nowUnix(),

			BodyFTS:     ExtractBodyForFTS(content),
			TagNamesFTS: JoinTagNamesForFTS(tags),
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

		x.syncDerivedDataWithTags(ctx, rec.ID, rec.Path, content, tags, registry)
		return nil
	})
	if walkErr != nil {
		return upserts, fmt.Errorf("reconcile full: walk: %w", walkErr)
	}
	return upserts, nil
}

func (x *Indexer) syncDerivedDataWithTags(ctx context.Context, id uuid.UUID, path string, content []byte, tags []string, registry *notes.Registry) {
	if err := x.SyncTags(ctx, id, tags); err != nil {
		x.Log.Warn("reconcile: tag sync failed", "id", id, "err", err)
	}

	refs := markdown.ExtractWikilinks(content)
	if err := x.SyncBacklinks(ctx, id, path, refs, registry, content); err != nil {
		x.Log.Warn("reconcile: backlink sync failed", "id", id, "err", err)
	}
}

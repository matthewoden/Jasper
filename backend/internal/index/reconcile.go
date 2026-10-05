package index

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"sort"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// ReconcileResult is what a reconcile pass did.
type ReconcileResult struct {
	// N is the count of indexed notes afterwards for incremental, and the
	// count upserted for full.
	N int
	// Deltas lists every note whose references the pass changed. The indexer
	// has no broadcaster; callers announce these.
	Deltas []notes.RefsDeltaFor
}

// Reconcile runs at startup and from the admin reindex endpoint.
//
// Reconcile is a thin wrapper over ReconcileWithRegistry that passes nil
// for the registry — all wiki-link targets are treated as pending in that
// case.
func (x *Indexer) Reconcile(ctx context.Context, mode Mode) (ReconcileResult, error) {
	return x.ReconcileWithRegistry(ctx, mode, nil)
}

// ReconcileWithRegistry extends Reconcile with per-file tag extraction
// (SyncTags) and wiki-link extraction (SyncBacklinks) after each
// successful Upsert. Both operations are non-fatal per the file-first
// contract — errors are logged and the per-file walk continues.
//
// registry is the title→note registry used for ambiguity resolution in
// SyncBacklinks. Pass nil to treat every wiki-link target as pending (safe —
// pending rows are updated when the registry is available).
func (x *Indexer) ReconcileWithRegistry(ctx context.Context, mode Mode, registry *notes.Registry) (ReconcileResult, error) {
	if mode != ModeFull && mode != ModeIncremental {
		return ReconcileResult{}, fmt.Errorf("indexer: unknown mode %q", mode)
	}
	res, err := x.reconcile(ctx, mode, registry)

	if repairErr := x.checkAndRepairFTSDivergence(ctx); repairErr != nil {
		x.Log.Error("FTS5 divergence repair failed (non-fatal)", "err", repairErr)
	}
	return res, err
}

// claim is one .md file the pass read, and the id it ends up indexed under.
type claim struct {
	meta    FileMeta
	content []byte
	fileID  notes.ID // the valid id the frontmatter carries, or ""
	wantID  notes.ID // fileID, else the id the path was indexed under
	id      notes.ID // settled by assignIDs
}

// reconcile walks the vault in three phases: read every changed file and the
// id it claims, settle which path keeps a contested id, then write ids that
// are missing or lost and upsert. Ids are settled before any upsert because
// Upsert is keyed on id and would silently move a row to whichever copy came
// last.
func (x *Indexer) reconcile(ctx context.Context, mode Mode, registry *notes.Registry) (ReconcileResult, error) {
	existing, err := x.existing(ctx)
	if err != nil {
		return ReconcileResult{}, fmt.Errorf("reconcile %s: load existing: %w", mode, err)
	}
	seen := make(map[string]bool, len(existing))
	var claims []*claim

	walkErr := WalkVault(ctx, x.NotesDir, func(fm FileMeta) error {
		seen[fm.CanonicalRelPath] = true
		cur, ok := existing[fm.CanonicalRelPath]

		if mode == ModeIncremental && ok && cur.MTime == fm.MTimeUnix {
			// Heal migration 006's 0 sentinel for otherwise-untouched files:
			// the walk already statted the file, so backfilling costs one
			// UPDATE and only when a real birthtime is newly available.
			// Without this, an upgraded vault's "created" sort runs on
			// first-seen timestamps until a manual full reindex.
			if cur.Birthtime == 0 && fm.BirthtimeUnix > 0 {
				if err := x.setBirthtime(ctx, cur.ID, fm.BirthtimeUnix); err != nil {
					x.Log.Warn("indexer: birthtime backfill failed (non-fatal)",
						"path", fm.CanonicalRelPath, "err", err)
				}
			}
			return nil
		}

		content, err := os.ReadFile(fm.AbsPath)
		if err != nil {
			x.Log.Warn("indexer: read failed; skipping",
				"path", fm.CanonicalRelPath, "err", err)
			return nil
		}

		c := &claim{meta: fm, content: content}
		if raw, found := markdown.ReadID(content); found {
			id, perr := notes.ParseID(raw)
			if perr != nil {
				x.Log.Warn("indexer: malformed id in frontmatter; reassigning",
					"path", fm.CanonicalRelPath, "id", raw)
			}
			c.fileID = id
		}
		c.wantID = c.fileID
		if c.wantID == "" && ok {
			c.wantID = cur.ID
		}
		claims = append(claims, c)
		return nil
	})
	if walkErr != nil {
		return ReconcileResult{}, fmt.Errorf("reconcile %s: walk: %w", mode, walkErr)
	}

	assignIDs(claims, existing, seen)
	if x.afterWalk != nil {
		x.afterWalk()
	}

	var res ReconcileResult
	for _, c := range claims {
		if c.id != c.fileID {
			x.writeID(c)
		}

		if cur, ok := existing[c.meta.CanonicalRelPath]; ok && cur.ID != c.id {
			if err := x.deleteAtPath(ctx, cur.ID, c.meta.CanonicalRelPath); err != nil {
				return ReconcileResult{}, fmt.Errorf("reconcile %s: retire %s at %s: %w", mode, cur.ID, c.meta.CanonicalRelPath, err)
			}
		}

		tags := unionTags(markdown.ExtractTags(c.content), markdown.ExtractBodyTags(c.content))
		rec := notes.NoteRecord{
			ID:            c.id,
			Path:          c.meta.CanonicalRelPath,
			Title:         ExtractTitle(c.content, c.meta.CanonicalRelPath),
			MTimeUnix:     c.meta.MTimeUnix,
			SizeBytes:     c.meta.Size,
			Checksum:      "",
			UpdatedAtUnix: x.nowUnix(),

			BodyFTS:       markdown.ExtractBodyForFTS(c.content),
			TagNamesFTS:   markdown.JoinTagNamesForFTS(tags),
			BirthtimeUnix: c.meta.BirthtimeUnix,
		}
		if err := x.Upsert(ctx, rec); err != nil {
			if errors.Is(err, notes.ErrCaseCollision) {
				x.Log.Warn("indexer: case collision; skipping",
					"path", c.meta.CanonicalRelPath, "err", err)
				continue
			}
			return ReconcileResult{}, fmt.Errorf("upsert %s: %w", c.meta.CanonicalRelPath, err)
		}
		res.N++

		if delta := x.syncDerivedDataWithTags(ctx, rec.ID, rec.Path, c.content, tags, registry); !delta.Empty() {
			res.Deltas = append(res.Deltas, notes.RefsDeltaFor{ID: rec.ID, Delta: delta})
		}
	}

	// A vanished path whose id now lives at a seen path was moved, not
	// deleted: the upsert above already carried the row to its new path.
	claimed := make(map[notes.ID]bool, len(claims))
	for _, c := range claims {
		claimed[c.id] = true
	}
	for relPath, row := range existing {
		if seen[relPath] || claimed[row.ID] {
			continue
		}
		if err := x.deleteAtPath(ctx, row.ID, relPath); err != nil {
			return ReconcileResult{}, fmt.Errorf("reconcile %s: delete %s: %w", mode, relPath, err)
		}
	}

	if err := x.reconcileBlobs(ctx, mode); err != nil {
		return ReconcileResult{}, fmt.Errorf("reconcile %s: %w", mode, err)
	}

	if mode == ModeFull {
		return res, nil
	}
	if err := x.Pair.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM notes`).Scan(&res.N); err != nil {
		return ReconcileResult{}, fmt.Errorf("reconcile incremental: count: %w", err)
	}
	return res, nil
}

// assignIDs settles every claim's id. An id held by an unchanged, still-present
// row is taken; among files that read the same id, the path already indexed
// under it keeps it, then the earliest birthtime, then the lexically smaller
// path. Everyone else is minted a fresh id, or the scratchpad's fixed one.
func assignIDs(claims []*claim, existing map[string]existingRow, seen map[string]bool) {
	taken := make(map[notes.ID]bool, len(existing))
	reading := make(map[string]bool, len(claims))
	for _, c := range claims {
		reading[c.meta.CanonicalRelPath] = true
	}
	for path, row := range existing {
		if seen[path] && !reading[path] {
			taken[row.ID] = true
		}
	}

	byWant := make(map[notes.ID][]*claim, len(claims))
	for _, c := range claims {
		if c.wantID != "" {
			byWant[c.wantID] = append(byWant[c.wantID], c)
		}
	}
	for id, group := range byWant {
		if taken[id] {
			continue
		}
		sort.SliceStable(group, func(i, j int) bool {
			pi, pj := group[i].meta.CanonicalRelPath, group[j].meta.CanonicalRelPath
			ii, ij := existing[pi].ID == id, existing[pj].ID == id
			if ii != ij {
				return ii
			}
			bi, bj := group[i].meta.BirthtimeUnix, group[j].meta.BirthtimeUnix
			if (bi > 0) != (bj > 0) {
				return bi > 0
			}
			if bi != bj {
				return bi < bj
			}
			return pi < pj
		})
		group[0].id = id
		taken[id] = true
	}

	for _, c := range claims {
		if c.id != "" {
			continue
		}
		id := chooseID("", c.meta.CanonicalRelPath)
		for taken[id] {
			id = notes.NewID()
		}
		c.id = id
		taken[id] = true
	}
}

// writeID puts the settled id into the file. A refusal (CRLF frontmatter)
// leaves the file alone and indexes the note under an id only this index
// knows; the next rebuild will mint another.
//
// The file is re-read first so a save that landed since the walk is kept, not
// overwritten. That leaves a read-to-rename window; closing it would need the
// service's per-note lock, which is keyed by the id this file doesn't have yet.
func (x *Indexer) writeID(c *claim) {
	if fresh, err := os.ReadFile(c.meta.AbsPath); err == nil && !bytes.Equal(fresh, c.content) {
		x.Log.Info("indexer: note changed since the walk; using its new content", "path", c.meta.CanonicalRelPath)
		c.content = fresh
		c.meta.Size = int64(len(fresh))
		if info, err := os.Stat(c.meta.AbsPath); err == nil {
			c.meta.MTimeUnix = info.ModTime().Unix()
		}
		if raw, found := markdown.ReadID(fresh); found {
			if id, perr := notes.ParseID(raw); perr == nil {
				c.id, c.fileID = id, id
				return
			}
		}
	}
	updated, err := markdown.WithID(c.content, c.id.String())
	if err != nil {
		x.Log.Warn("indexer: not writing id into note", "path", c.meta.CanonicalRelPath, "err", err)
		return
	}
	if err := fsstore.AtomicWrite(c.meta.AbsPath, updated); err != nil {
		x.Log.Warn("indexer: id write failed; indexing under the id anyway",
			"path", c.meta.CanonicalRelPath, "err", err)
		return
	}
	c.content = updated
	c.meta.Size = int64(len(updated))
	if info, err := os.Stat(c.meta.AbsPath); err == nil {
		c.meta.MTimeUnix = info.ModTime().Unix()
	}
	x.Log.Info("indexer: wrote id into note", "path", c.meta.CanonicalRelPath, "id", c.id)
}

// unionTags returns the deduplicated, sorted union of frontmatter tags (a)
// and inline body tags (b) — matching the same union the live save path
// applies (notes.Service.unionTags) so reconcile and save produce identical
// tag sets for a given file's content.
func unionTags(a, b []string) []string {
	seen := make(map[string]struct{}, len(a)+len(b))
	out := make([]string, 0, len(a)+len(b))
	for _, t := range append(append([]string(nil), a...), b...) {
		if _, ok := seen[t]; !ok {
			seen[t] = struct{}{}
			out = append(out, t)
		}
	}
	sort.Strings(out)
	return out
}

func (x *Indexer) syncDerivedDataWithTags(ctx context.Context, id notes.ID, path string, content []byte, tags []string, registry *notes.Registry) notes.RefsDelta {
	if err := x.SyncTags(ctx, id, tags); err != nil {
		x.Log.Warn("reconcile: tag sync failed", "id", id, "err", err)
	}

	delta, err := x.SyncBacklinks(ctx, id, path, markdown.ExtractRefs(content), registry, content)
	if err != nil {
		x.Log.Warn("reconcile: backlink sync failed", "id", id, "err", err)
	}
	return delta
}

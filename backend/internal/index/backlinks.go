package index

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"html"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// BacklinkRow is an alias for notes.BacklinkRow used within the index package.
//
// Deprecated: use notes.BacklinkRow directly.
type BacklinkRow = notes.BacklinkRow

// SyncBacklinks rewrites every backlinks row and every refs row for sourceID
// in one BEGIN IMMEDIATE transaction. Title links resolve with a bias toward
// the source's own folder and feed both tables; ref-shaped targets feed refs
// only. A nil registry leaves every title link pending.
//
// backlinks holds one row per excerpt LINE — migration 005 dropped the
// UNIQUE(source_id, target_title) collapse specifically to allow that.
func (x *Indexer) SyncBacklinks(
	ctx context.Context,
	sourceID notes.ID,
	sourcePath string,
	refs []markdown.Ref,
	registry *notes.Registry,
	content []byte,
) (notes.RefsDelta, error) {
	sourceFolder := filepath.Dir(sourcePath)

	type pendingRow struct {
		targetTitle string
		targetID    *notes.ID
		excerpts    []string
	}
	grouped := make(map[string]*pendingRow, len(refs))
	order := make([]string, 0, len(refs))
	resolved := make([]string, len(refs))

	for i, r := range refs {
		if markdown.IsRefTarget(r.Target) {
			resolved[i] = r.Target
			continue
		}
		if r.Position < 0 {
			continue
		}
		key := strings.ToLower(r.Target)
		row, seen := grouped[key]
		if !seen {
			var tid *notes.ID
			if registry != nil {
				candidates := registry.FindByTitle(key, sourceFolder)
				if len(candidates) > 0 {
					cid := candidates[0].ID
					tid = &cid
				}
			}
			row = &pendingRow{
				targetTitle: r.Target,
				targetID:    tid,
				excerpts:    buildExcerpts(content, r.Target),
			}
			grouped[key] = row
			order = append(order, key)
		}
		if row.targetID != nil {
			resolved[i] = notes.RefForNote(*row.targetID)
		} else {
			resolved[i] = notes.RefForTitle(r.Target)
		}
	}

	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return notes.RefsDelta{}, fmt.Errorf("syncbacklinks begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	before, err := distinctTargets(ctx, tx, sourceID)
	if err != nil {
		return notes.RefsDelta{}, err
	}

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM backlinks WHERE source_id = ?`, sourceID.String()); err != nil {
		return notes.RefsDelta{}, fmt.Errorf("syncbacklinks clear: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM refs WHERE source_id = ?`, sourceID.String()); err != nil {
		return notes.RefsDelta{}, fmt.Errorf("syncrefs clear: %w", err)
	}

	for _, key := range order {
		row := grouped[key]
		var tidStr any
		if row.targetID != nil {
			tidStr = row.targetID.String()
		}
		excerpts := row.excerpts
		if len(excerpts) == 0 {
			// Defensive: a ref was extracted but no matching line was found
			// in content (e.g. stale content snapshot). Still record the
			// reference with an empty excerpt so the link is not silently
			// dropped.
			excerpts = []string{""}
		}
		for _, excerpt := range excerpts {
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO backlinks(source_id, target_id, target_title, excerpt)
				 VALUES(?, ?, ?, ?)`,
				sourceID.String(), tidStr, row.targetTitle, excerpt); err != nil {
				return notes.RefsDelta{}, fmt.Errorf("syncbacklinks insert %q: %w", row.targetTitle, err)
			}
		}
	}

	after := make(map[string]bool, len(refs))
	for i, r := range refs {
		if resolved[i] == "" {
			continue
		}
		after[resolved[i]] = true
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO refs(source_id, target_ref, display, position, embed) VALUES(?, ?, ?, ?, ?)`,
			sourceID.String(), resolved[i], r.Display, r.Position, r.Embed); err != nil {
			return notes.RefsDelta{}, fmt.Errorf("syncrefs insert %q: %w", resolved[i], err)
		}
	}

	if err := tx.Commit(); err != nil {
		return notes.RefsDelta{}, fmt.Errorf("syncbacklinks commit: %w", err)
	}

	var delta notes.RefsDelta
	for t := range after {
		if !before[t] {
			delta.Added = append(delta.Added, t)
		}
	}
	for t := range before {
		if !after[t] {
			delta.Removed = append(delta.Removed, t)
		}
	}
	sort.Strings(delta.Added)
	sort.Strings(delta.Removed)
	return delta, nil
}

func distinctTargets(ctx context.Context, tx *sql.Tx, sourceID notes.ID) (map[string]bool, error) {
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT target_ref FROM refs WHERE source_id = ?`, sourceID.String())
	if err != nil {
		return nil, fmt.Errorf("syncrefs prior: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]bool{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, fmt.Errorf("syncrefs prior scan: %w", err)
		}
		out[t] = true
	}
	return out, rows.Err()
}

// GetBacklinks returns the resolved backlinks for targetID, sorted by source
// note recency (mtime_unix DESC). Pending rows (target_id IS NULL) are
// excluded. Returns a non-nil empty slice when there are no backlinks.
//
// Rows are grouped one card per source_id via json_group_array. The
// aggregate's own ORDER BY clause (SQLite >= 3.44) guarantees each card's
// excerpts array preserves b.id insertion/document order — an ordered
// subquery feeding an aggregate is NOT guaranteed to preserve order.
func (x *Indexer) GetBacklinks(ctx context.Context, targetID notes.ID) ([]BacklinkRow, error) {
	rows, err := x.Pair.Reader.QueryContext(ctx,
		`SELECT source_id, title, path,
		        json_group_array(excerpt ORDER BY bl_id) AS excerpts
		 FROM (
		     SELECT b.id AS bl_id, b.source_id AS source_id, n.title AS title,
		            n.path AS path, b.excerpt AS excerpt, n.mtime_unix AS mtime_unix
		     FROM backlinks b
		     INNER JOIN notes n ON n.id = b.source_id
		     WHERE b.target_id = ?
		 )
		 GROUP BY source_id
		 ORDER BY mtime_unix DESC`,
		targetID.String())
	if err != nil {
		return nil, fmt.Errorf("getbacklinks query: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []BacklinkRow{}
	for rows.Next() {
		var sourceIDStr, title, path, excerptsJSON string
		if err := rows.Scan(&sourceIDStr, &title, &path, &excerptsJSON); err != nil {
			return nil, fmt.Errorf("getbacklinks scan: %w", err)
		}
		sid, err := notes.ParseID(sourceIDStr)
		if err != nil {
			return nil, fmt.Errorf("getbacklinks parse id %q: %w", sourceIDStr, err)
		}
		var excerpts []string
		if err := json.Unmarshal([]byte(excerptsJSON), &excerpts); err != nil {
			return nil, fmt.Errorf("getbacklinks unmarshal excerpts %q: %w", excerptsJSON, err)
		}
		out = append(out, BacklinkRow{
			SourceID:    sid,
			SourceTitle: title,
			SourcePath:  path,
			Excerpts:    excerpts,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("getbacklinks rows: %w", err)
	}
	return out, nil
}

// SourcesByBacklinkTitle returns a NoteSummary for every source note that
// contains a backlink row where target_title = title (case-sensitive, as
// stored by SyncBacklinks). Used by RenameRewriteWikilinks to find all
// referrer notes without a full-vault FS scan.
//
// Returns a non-nil empty slice when no referrers exist.
func (x *Indexer) SourcesByBacklinkTitle(ctx context.Context, title string) ([]notes.NoteSummary, error) {
	rows, err := x.Pair.Reader.QueryContext(ctx,
		`SELECT n.id, n.path, n.title, n.mtime_unix
		 FROM backlinks b
		 INNER JOIN notes n ON n.id = b.source_id
		 WHERE b.target_title = ? COLLATE NOCASE
		 ORDER BY n.mtime_unix DESC`,
		title)
	if err != nil {
		return nil, fmt.Errorf("sourcesbybltitle query: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []notes.NoteSummary{}
	for rows.Next() {
		var idStr, p, t string
		var mtime int64
		if err := rows.Scan(&idStr, &p, &t, &mtime); err != nil {
			return nil, fmt.Errorf("sourcesbybltitle scan: %w", err)
		}
		id, err := notes.ParseID(idStr)
		if err != nil {
			return nil, fmt.Errorf("sourcesbybltitle parse id %q: %w", idStr, err)
		}
		out = append(out, notes.NoteSummary{
			ID:        id,
			Path:      p,
			Title:     t,
			UpdatedAt: time.Unix(mtime, 0).UTC(),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sourcesbybltitle rows: %w", err)
	}
	return out, nil
}

// UpdateBacklinksTargetTitle re-points every row at oldTitle without a full
// SyncBacklinks per referrer.
//
// newTargetID is usually nil: a rename keeps the same id and changes only the
// title. Pass non-nil only when the ID actually changes.
func (x *Indexer) UpdateBacklinksTargetTitle(
	ctx context.Context, oldTitle, newTitle string, newTargetID *notes.ID,
) error {
	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return fmt.Errorf("updatebltitle begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if newTargetID != nil {
		_, err = tx.ExecContext(ctx,
			`UPDATE backlinks SET target_title = ?, target_id = ? WHERE target_title = ?`,
			newTitle, newTargetID.String(), oldTitle)
	} else {
		_, err = tx.ExecContext(ctx,
			`UPDATE backlinks SET target_title = ? WHERE target_title = ?`,
			newTitle, oldTitle)
	}
	if err != nil {
		return fmt.Errorf("updatebltitle update: %w", err)
	}
	// A resolved link's ref names the id, which a rename keeps; only the
	// pending form carries the title.
	if _, err := tx.ExecContext(ctx,
		`UPDATE refs SET target_ref = ? WHERE target_ref = ?`,
		notes.RefForTitle(newTitle), notes.RefForTitle(oldTitle)); err != nil {
		return fmt.Errorf("updatebltitle refs: %w", err)
	}
	return tx.Commit()
}

// ResolvePendingBacklinks runs after registry hydration, because reconcile runs
// before the registry is populated and leaves every startup-synced link pending.
//
// The update is scoped per source, not per title: when two notes share a title
// in different folders each source must resolve with its own folder bias, or it
// disagrees with what a later save of that source would produce.
//
// Non-fatal — anything unresolved is retried on the next save.
func (x *Indexer) ResolvePendingBacklinks(ctx context.Context, registry *notes.Registry) error {
	if registry == nil {
		return nil
	}

	rows, err := x.Pair.Reader.QueryContext(ctx,
		`SELECT DISTINCT b.target_title, b.source_id, n.path
		 FROM backlinks b
		 INNER JOIN notes n ON n.id = b.source_id
		 WHERE b.target_id IS NULL`)
	if err != nil {
		return fmt.Errorf("resolve pending: query: %w", err)
	}
	defer func() { _ = rows.Close() }()

	type pending struct{ targetTitle, sourceID, sourcePath string }
	var pendings []pending
	for rows.Next() {
		var tt, sid, sp string
		if err := rows.Scan(&tt, &sid, &sp); err != nil {
			return fmt.Errorf("resolve pending: scan: %w", err)
		}
		pendings = append(pendings, pending{tt, sid, sp})
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("resolve pending: rows: %w", err)
	}

	for _, p := range pendings {
		key := strings.ToLower(p.targetTitle)
		sourceFolder := filepath.Dir(p.sourcePath)
		candidates := registry.FindByTitle(key, sourceFolder)
		if len(candidates) == 0 {
			continue
		}
		tid := candidates[0].ID
		if _, err := x.Pair.Writer.ExecContext(ctx,
			`UPDATE backlinks SET target_id = ?
			 WHERE target_id IS NULL AND target_title = ? AND source_id = ?`,
			tid.String(), p.targetTitle, p.sourceID); err != nil {
			x.Log.Warn("resolve pending: update failed", "title", p.targetTitle, "err", err)
		}
		if _, err := x.Pair.Writer.ExecContext(ctx,
			`UPDATE refs SET target_ref = ? WHERE source_id = ? AND target_ref = ?`,
			notes.RefForNote(tid), p.sourceID, notes.RefForTitle(p.targetTitle)); err != nil {
			x.Log.Warn("resolve pending: refs update failed", "title", p.targetTitle, "err", err)
		}
	}
	return nil
}

// buildExcerpts scans content for every LINE containing a [[target]]
// reference (case-insensitive) and returns one HTML excerpt per matching
// line, in document order. Multiple occurrences of [[target]] on the
// SAME line collapse into a single excerpt for that line — the tie-break is
// per LINE, not per raw occurrence. Returns a
// nil slice when there is no matching line.
func buildExcerpts(content []byte, target string) []string {
	targetLower := strings.ToLower(target)
	searchFor := "[[" + targetLower

	var excerpts []string
	for _, lineBytes := range bytes.Split(content, []byte("\n")) {
		line := string(lineBytes)
		lineLower := strings.ToLower(line)

		// Accept an occurrence only when the character following the target
		// terminates the link target (']', '|', '#'); otherwise "[[Target"
		// would false-match longer titles sharing the prefix (e.g.
		// "[[Targeted Ads]]"). Iterate occurrences so a legitimate match
		// later on the same line is still found.
		idx := -1
		for from := 0; from < len(lineLower); {
			cand := strings.Index(lineLower[from:], searchFor)
			if cand < 0 {
				break
			}
			cand += from
			after := cand + len(searchFor)
			if after >= len(lineLower) ||
				lineLower[after] == ']' || lineLower[after] == '|' || lineLower[after] == '#' {
				idx = cand
				break
			}
			from = cand + 1
		}
		if idx < 0 {
			continue
		}

		closeIdx := strings.Index(line[idx:], "]]")
		if closeIdx < 0 {
			continue
		}

		matchEnd := idx + closeIdx + 2
		matchedText := line[idx:matchEnd]

		prefix := strings.TrimSpace(line[:idx])

		suffix := strings.TrimSpace(line[matchEnd:])

		const maxChunk = 80
		if utf8.RuneCountInString(prefix) > maxChunk {
			runes := []rune(prefix)
			prefix = "…" + string(runes[len(runes)-maxChunk:])
		}

		if utf8.RuneCountInString(suffix) > maxChunk {
			runes := []rune(suffix)
			suffix = string(runes[:maxChunk]) + "…"
		}

		// The matched span is verbatim note content too (e.g. a long aliased
		// wikilink) — cap it like prefix/suffix so an excerpt's visible text
		// stays bounded per the API contract.
		if utf8.RuneCountInString(matchedText) > maxChunk {
			runes := []rune(matchedText)
			matchedText = string(runes[:maxChunk]) + "…"
		}

		var sb strings.Builder
		if prefix != "" {
			sb.WriteString(`<span>`)
			sb.WriteString(html.EscapeString(prefix))
			sb.WriteString(` </span>`)
		}
		sb.WriteString(`<mark class="backlink-ref">`)
		sb.WriteString(html.EscapeString(matchedText))
		sb.WriteString(`</mark>`)
		if suffix != "" {
			sb.WriteString(`<span> `)
			sb.WriteString(html.EscapeString(suffix))
			sb.WriteString(`</span>`)
		}

		excerpts = append(excerpts, sb.String())
	}
	return excerpts
}

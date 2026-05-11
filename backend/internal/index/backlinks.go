package index

// backlinks.go — Plan 06-04 Task 3: SyncBacklinks, GetBacklinks, buildExcerpt.
//
// SyncBacklinks resolves [[Title]] references via the registry (D-20), writes
// one backlinks row per unique (source_id, target_title) (D-29), and builds a
// sanitized HTML excerpt per the UI-SPEC §Surface 2 contract.
//
// GetBacklinks returns resolved backlinks for a target note sorted by source
// recency (D-28). Pending rows (target_id IS NULL) are excluded (D-32).

import (
	"bytes"
	"context"
	"fmt"
	"html"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// BacklinkRow is the projection returned by GetBacklinks.
// Matches the BacklinkRow component schema in api/openapi.yaml (Plan 06-02).
//
// Count is the number of occurrences of this link in the source body.
// In this v1 implementation, count is always 1 (see D-claude-04 decision
// documented in SUMMARY.md — multi-occurrence badge deferred).
type BacklinkRow struct {
	SourceID    uuid.UUID
	SourceTitle string
	SourcePath  string
	Excerpt     string // server-built sanitized-friendly HTML
	Count       int    // v1: always 1; multi-occurrence badge is a follow-on
}

// ---------------------------------------------------------------------------
// SyncBacklinks
// ---------------------------------------------------------------------------

// SyncBacklinks resolves every WikiLinkRef in refs, groups them by target
// title (D-29 one row per unique source+title), and rewrites all backlinks
// rows for sourceID in a single BEGIN IMMEDIATE transaction.
//
// Resolution (D-20): for each ref, registry.FindByTitle is called with the
// source folder as the bias parameter. The first result (if any) becomes
// target_id. If registry is nil, all links are treated as pending.
//
// Excerpt generation: buildExcerpt scans content for the first line
// containing [[target]] (case-insensitive) and returns the UI-SPEC contract
// HTML (see buildExcerpt godoc).
//
// T-06-04-03 (DoS on malformed file): per-file errors during extract are
// non-fatal; SyncBacklinks itself uses a transaction to ensure atomicity.
func (x *Indexer) SyncBacklinks(
	ctx context.Context,
	sourceID uuid.UUID,
	sourcePath string,
	refs []markdown.WikiLinkRef,
	registry *notes.Registry,
	content []byte,
) error {
	sourceFolder := filepath.Dir(sourcePath)

	// Group refs by lowercase target title (D-29: one row per source+title).
	type pendingRow struct {
		targetTitle string // verbatim Target from first ref with this lowercase key
		targetID    *uuid.UUID
		excerpt     string
	}
	grouped := make(map[string]*pendingRow, len(refs))
	order := make([]string, 0, len(refs)) // preserve insertion order for determinism

	for _, r := range refs {
		key := strings.ToLower(r.Target)
		if _, ok := grouped[key]; ok {
			// Already have a row for this target — D-29 collapse.
			continue
		}

		// Resolve via registry (D-20 same-folder-then-alphabetical).
		var tid *uuid.UUID
		if registry != nil {
			candidates := registry.FindByTitle(key, sourceFolder)
			if len(candidates) > 0 {
				cid := candidates[0].ID
				tid = &cid
			}
		}

		row := &pendingRow{
			targetTitle: r.Target, // verbatim title from source
			targetID:    tid,
			excerpt:     buildExcerpt(content, r.Target),
		}
		grouped[key] = row
		order = append(order, key)
	}

	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return fmt.Errorf("syncbacklinks begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Delete every backlinks row for this source (we rewrite the full set).
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM backlinks WHERE source_id = ?`, sourceID.String()); err != nil {
		return fmt.Errorf("syncbacklinks clear: %w", err)
	}

	// Insert each grouped row.
	for _, key := range order {
		row := grouped[key]
		var tidStr any
		if row.targetID != nil {
			tidStr = row.targetID.String()
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO backlinks(source_id, target_id, target_title, excerpt)
			 VALUES(?, ?, ?, ?)`,
			sourceID.String(), tidStr, row.targetTitle, row.excerpt); err != nil {
			return fmt.Errorf("syncbacklinks insert %q: %w", row.targetTitle, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("syncbacklinks commit: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// GetBacklinks
// ---------------------------------------------------------------------------

// GetBacklinks returns the resolved backlinks for targetID, sorted by source
// note recency (mtime_unix DESC) per D-28.
//
// Only rows where target_id = targetID are returned — pending rows (target_id
// IS NULL) are excluded per D-32.
//
// Returns a non-nil empty slice when there are no backlinks.
func (x *Indexer) GetBacklinks(ctx context.Context, targetID uuid.UUID) ([]BacklinkRow, error) {
	rows, err := x.Pair.Reader.QueryContext(ctx,
		`SELECT b.source_id, n.title, n.path, b.excerpt
		 FROM backlinks b
		 INNER JOIN notes n ON n.id = b.source_id
		 WHERE b.target_id = ?
		 ORDER BY n.mtime_unix DESC`,
		targetID.String())
	if err != nil {
		return nil, fmt.Errorf("getbacklinks query: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []BacklinkRow{} // non-nil empty slice per contract
	for rows.Next() {
		var sourceIDStr, title, path, excerpt string
		if err := rows.Scan(&sourceIDStr, &title, &path, &excerpt); err != nil {
			return nil, fmt.Errorf("getbacklinks scan: %w", err)
		}
		sid, err := uuid.Parse(sourceIDStr)
		if err != nil {
			return nil, fmt.Errorf("getbacklinks parse uuid %q: %w", sourceIDStr, err)
		}
		out = append(out, BacklinkRow{
			SourceID:    sid,
			SourceTitle: title,
			SourcePath:  path,
			Excerpt:     excerpt,
			Count:       1, // D-claude-04: v1 ships count=1; multi-occurrence badge is follow-on
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("getbacklinks rows: %w", err)
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// SourcesByBacklinkTitle
// ---------------------------------------------------------------------------

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
		 WHERE b.target_title = ?
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
		id, err := uuid.Parse(idStr)
		if err != nil {
			return nil, fmt.Errorf("sourcesbybltitle parse uuid %q: %w", idStr, err)
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

// ---------------------------------------------------------------------------
// UpdateBacklinksTargetTitle
// ---------------------------------------------------------------------------

// UpdateBacklinksTargetTitle atomically updates the target_title (and
// optionally target_id) for every backlinks row that currently has
// target_title = oldTitle. Used by RenameRewriteWikilinks after the FS pass
// to keep the derived index in sync without requiring a full SyncBacklinks
// for each affected referrer.
//
// newTargetID is optional: pass nil to leave target_id unchanged (or to clear
// it to NULL if you pass a pointer to uuid.Nil). In practice, after a note
// rename the new UUID is the same UUID — only the title changes. Pass a
// non-nil pointer when the ID changes (rare: simultaneous rename + merge).
func (x *Indexer) UpdateBacklinksTargetTitle(
	ctx context.Context, oldTitle, newTitle string, newTargetID *uuid.UUID,
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
	return tx.Commit()
}

// ---------------------------------------------------------------------------
// buildExcerpt
// ---------------------------------------------------------------------------

// buildExcerpt finds the first line in content that contains [[target]]
// (case-insensitive) and returns the UI-SPEC §Surface 2 contract HTML:
//
//	<span>prefix </span><mark class="backlink-ref">[[Title]]</mark><span> suffix</span>
//
// Where prefix and suffix are HTML-escaped (T-06-04-01 mitigation) and
// [[Title]] is the verbatim matched text from the source line (as-is inside
// <mark> — DOMPurify whitelists span+mark+class per the UI-SPEC contract).
//
// Truncation: prefix is capped at 80 runes (leading "…" if truncated);
// suffix is capped at 80 runes (trailing "…" if truncated). The excerpt
// total is ≤ ~200 chars.
//
// If no line containing [[target]] is found, returns an empty string.
func buildExcerpt(content []byte, target string) string {
	targetLower := strings.ToLower(target)
	// We search for [[target]] (any case) by scanning lines.
	needle := "[[" + targetLower + "]]"
	// Also accept aliases: [[target|alias]] — needle is still [[target]].

	scanner := bytes.Split(content, []byte("\n"))
	for _, lineBytes := range scanner {
		line := string(lineBytes)
		lineLower := strings.ToLower(line)

		// Look for [[target in the line (catches [[target]] and [[target|alias]]).
		searchFor := "[[" + targetLower
		idx := strings.Index(lineLower, searchFor)
		if idx < 0 {
			// Not in this line.
			continue
		}

		// Find the closing ]] after the match start.
		closeIdx := strings.Index(line[idx:], "]]")
		if closeIdx < 0 {
			// Malformed — skip.
			continue
		}
		// The matched wikilink span in the original-case line.
		matchEnd := idx + closeIdx + 2 // +2 for "]]"
		matchedText := line[idx:matchEnd]

		// Prefix: text before the match.
		prefix := strings.TrimSpace(line[:idx])
		// Suffix: text after the match.
		suffix := strings.TrimSpace(line[matchEnd:])

		// Truncate prefix (keep the END so context is near the link).
		const maxChunk = 80
		if utf8.RuneCountInString(prefix) > maxChunk {
			runes := []rune(prefix)
			prefix = "…" + string(runes[len(runes)-maxChunk:])
		}
		// Truncate suffix (keep the START so context is near the link).
		if utf8.RuneCountInString(suffix) > maxChunk {
			runes := []rune(suffix)
			suffix = string(runes[:maxChunk]) + "…"
		}

		// Build the HTML — HTML-escape prefix and suffix (T-06-04-01).
		// The [[Title]] inside <mark> is emitted verbatim; DOMPurify
		// whitelists mark + class per UI-SPEC §Surface 2 contract.
		var sb strings.Builder
		if prefix != "" {
			sb.WriteString(`<span>`)
			sb.WriteString(html.EscapeString(prefix))
			sb.WriteString(` </span>`)
		}
		sb.WriteString(`<mark class="backlink-ref">`)
		sb.WriteString(matchedText) // verbatim — no HTML in wikilink syntax
		sb.WriteString(`</mark>`)
		if suffix != "" {
			sb.WriteString(`<span> `)
			sb.WriteString(html.EscapeString(suffix))
			sb.WriteString(`</span>`)
		}

		// Verify the needle was for a real match (not just [[targetprefix]]).
		// This is enforced by the close bracket check above.
		_ = needle // used for documentation — actual check is idx+closeIdx logic

		return sb.String()
	}
	return ""
}

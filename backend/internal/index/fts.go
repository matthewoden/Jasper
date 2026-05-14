// Package index — Plan 07-03: FTS5 index population helpers.
//
// ExtractBodyForFTS strips YAML frontmatter from note content before
// indexing into body_fts (D-37) so that "tags: [foo]" in frontmatter does
// not pollute full-text body matches.
//
// JoinTagNamesForFTS produces the space-joined list for tag_names_fts so
// that FTS5 unicode61 tokenizer treats each tag as a distinct query token.
//
// checkAndRepairFTSDivergence (D-36) detects and auto-repairs notes/notes_fts
// row-count divergence at startup.
//
// Note on frontmatter.go reuse: markdown.HasFrontmatter exists in
// backend/internal/markdown/frontmatter.go but its scanner-based approach
// is aimed at detection, not extraction. ExtractBodyForFTS uses a simpler
// byte-scan that is sufficient for the strip-and-return use-case. No
// duplication of YAML parsing — FTS only needs the bytes after the closing fence.
package index

import (
	"bytes"
	"context"
	"fmt"
	"strings"
)

// ExtractBodyForFTS strips a leading YAML frontmatter block (--- ... ---\n)
// from a markdown note's bytes and returns the remaining body as a string.
// Per D-37, frontmatter content (esp. "tags: [foo]") MUST NOT pollute body
// matches. Idempotent on already-stripped content.
//
// Edge cases:
//   - No leading "---" prefix: returns full content unchanged.
//   - Opening "---" present but no closing "\n---": treats all content as body
//     (unclosed frontmatter is not stripped — better to over-index than drop content).
//   - Empty content: returns "".
func ExtractBodyForFTS(content []byte) string {
	if !bytes.HasPrefix(content, []byte("---")) {
		return string(content)
	}
	// Find closing --- on its own line. Match the byte sequence "\n---" then a
	// newline or end-of-content.
	rest := content[3:]
	idx := bytes.Index(rest, []byte("\n---"))
	if idx == -1 {
		return string(content) // unterminated frontmatter → treat all as body
	}
	// Skip past the "\n---" itself (4 bytes); advance to the newline that follows.
	body := rest[idx+4:]
	// If the next byte is \n or \r, drop it (the blank line after the closing fence).
	if len(body) > 0 && (body[0] == '\n' || body[0] == '\r') {
		body = body[1:]
	}
	return strings.TrimLeft(string(body), "\n\r")
}

// JoinTagNamesForFTS returns the space-joined tag-name list used for the
// tag_names_fts column. Names are inserted exactly as the indexer normalized
// them (lowercase + trimmed) so FTS5 unicode61 tokenizer treats each as one token.
// Returns "" when the slice is nil or empty.
func JoinTagNamesForFTS(names []string) string {
	return strings.Join(names, " ")
}

// checkAndRepairFTSDivergence is called at startup AFTER the reconcile walk
// completes. It detects two forms of FTS5 index divergence (D-36):
//
//  1. Row-count mismatch: COUNT(notes_fts) != COUNT(notes). This can occur
//     when FTS shadow tables are corrupted or partially reset while the notes
//     content table remains intact.
//
//  2. Content staleness: all notes_fts rows have empty body_fts but notes
//     exist (post-migration 003 state where existing rows were migrated with
//     body_fts=” defaults). For an external-content FTS5 table, a 'rebuild'
//     re-reads body_fts/tag_names_fts from the notes content table and
//     re-indexes them, ensuring MATCH queries work after the indexer has
//     populated those columns via Upsert.
//
// The rebuild is wrapped in a BEGIN IMMEDIATE transaction (T-7-07 mitigation).
// On any error the failure is returned but the caller (ReconcileWithRegistry)
// treats this as non-fatal — the server continues, searches return empty
// results in the worst case.
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

	// Check 1: row-count divergence.
	rowsDiverge := notesCount != ftsCount

	// Check 2: content staleness — any notes_fts rows with non-empty body_fts?
	// If notes exist but ALL have empty body_fts, the FTS content was not yet
	// populated (post-migration 003 or after a 'delete-all' reset).
	contentStale := false
	if notesCount > 0 {
		var populated int
		if err := x.Pair.Reader.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM notes WHERE body_fts != ''`).Scan(&populated); err != nil {
			return fmt.Errorf("fts divergence check (populated count): %w", err)
		}
		// All notes have empty body_fts → FTS content is stale and needs rebuild.
		contentStale = populated == 0
	}

	if !rowsDiverge && !contentStale {
		return nil // index is healthy
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

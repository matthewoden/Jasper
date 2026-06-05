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

	rest := content[3:]
	idx := bytes.Index(rest, []byte("\n---"))
	if idx == -1 {
		return string(content)
	}

	body := rest[idx+4:]

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

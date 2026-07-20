package index

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

var fts5OperatorKeywordRE = regexp.MustCompile(`\b(AND|OR|NOT|NEAR)\b`)

// Upsert inserts or updates a row in `notes`.
//
// Case-collision detection (DATA-12) — two strategies, both required:
//
//  1. PRE-CHECK: SELECT id FROM notes WHERE path = ? AND id != ?. If a
//     row is found, return ErrCaseCollision before any INSERT runs.
//     This catches the common case where the indexer mints a NEW id for
//     a freshly-walked file but a different id already owns that path.
//  2. POST-CHECK: catch SQLite's UNIQUE constraint failure on
//     `notes.path` from the INSERT itself. This covers the race where
//     a concurrent Upsert wrote a colliding row between our SELECT and
//     INSERT.
//
// The transaction is BEGIN IMMEDIATE so concurrent writers serialize
// without SQLITE_BUSY.
//
// `checksum_sha256` is rec.Checksum, which the indexer currently always
// sets to "" — the column exists in the schema but checksum computation
// is deferred; callers should not rely on it being populated.
func (x *Indexer) Upsert(ctx context.Context, rec notes.NoteRecord) error {
	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return fmt.Errorf("upsert begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var existingID string
	err = tx.QueryRowContext(ctx,
		`SELECT id FROM notes WHERE path = ? AND id != ?`,
		rec.Path, rec.ID.String()).Scan(&existingID)
	if err == nil {
		return fmt.Errorf("upsert: %w (path=%s, existing_id=%s)",
			notes.ErrCaseCollision, rec.Path, existingID)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("upsert collision check: %w", err)
	}

	_, err = tx.ExecContext(ctx,
		`INSERT INTO notes(id, path, title, mtime_unix, size_bytes, checksum_sha256, created_at, updated_at, body_fts, tag_names_fts, birthtime_unix)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
             path = excluded.path,
             title = excluded.title,
             mtime_unix = excluded.mtime_unix,
             size_bytes = excluded.size_bytes,
             checksum_sha256 = excluded.checksum_sha256,
             updated_at = excluded.updated_at,
             body_fts = excluded.body_fts,
             tag_names_fts = excluded.tag_names_fts,
             birthtime_unix = excluded.birthtime_unix`,
		rec.ID.String(), rec.Path, rec.Title, rec.MTimeUnix,
		rec.SizeBytes, rec.Checksum, rec.UpdatedAtUnix, rec.UpdatedAtUnix,
		rec.BodyFTS, rec.TagNamesFTS, rec.BirthtimeUnix)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed: notes.path") {
			return fmt.Errorf("upsert: %w (path=%s)", notes.ErrCaseCollision, rec.Path)
		}
		return fmt.Errorf("upsert exec: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("upsert commit: %w", err)
	}
	return nil
}

// Delete removes the index row for the given UUID. Idempotent — a
// missing row is not an error (file-deletes can race with the indexer
// scan).
func (x *Indexer) Delete(ctx context.Context, id uuid.UUID) error {
	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return fmt.Errorf("delete begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM notes WHERE id = ?`, id.String()); err != nil {
		return fmt.Errorf("delete exec: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("delete commit: %w", err)
	}
	return nil
}

// List returns all rows from `notes` ordered by path ASC.
//
// UpdatedAt in the projection is mtime_unix converted to time.Time —
// the file's last-modified time, NOT the indexer's row-touch time.
// The index-touch time is internal-only and never escapes the package.
//
// CreatedAt is COALESCE(NULLIF(birthtime_unix, 0), created_at) — see D-04 —
// consumed by BuildTree to expose a "created" sort data point on tree nodes.
func (x *Indexer) List(ctx context.Context) ([]notes.NoteSummary, error) {
	rows, err := x.Pair.Reader.QueryContext(ctx,
		`SELECT id, path, title, mtime_unix, COALESCE(NULLIF(birthtime_unix, 0), created_at)
		 FROM notes ORDER BY path ASC`)
	if err != nil {
		return nil, fmt.Errorf("list query: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []notes.NoteSummary
	for rows.Next() {
		var idStr, path, title string
		var mtime, createdAt int64
		if err := rows.Scan(&idStr, &path, &title, &mtime, &createdAt); err != nil {
			return nil, fmt.Errorf("list scan: %w", err)
		}
		id, err := uuid.Parse(idStr)
		if err != nil {
			return nil, fmt.Errorf("list parse uuid %q: %w", idStr, err)
		}
		out = append(out, notes.NoteSummary{
			ID:        id,
			Path:      path,
			Title:     title,
			UpdatedAt: time.Unix(mtime, 0).UTC(),
			CreatedAt: time.Unix(createdAt, 0).UTC(),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list rows: %w", err)
	}
	return out, nil
}

// LookupByPath finds a NoteRecord by its canonical relative path. Returns
// notes.ErrNotFound when no row matches. Reads via Pair.Reader (no
// transaction — pure read). Used by Service.Move to look up the existing
// record before issuing the rename (so the same UUID stays attached to
// the moved file).
func (x *Indexer) LookupByPath(ctx context.Context, canonicalPath string) (notes.NoteRecord, error) {
	var (
		idStr, path, title, checksum                     string
		bodyFTS, tagNamesFTS                             string
		mtime, size, createdAt, updatedAt, birthtimeUnix int64
	)
	err := x.Pair.Reader.QueryRowContext(ctx,
		`SELECT id, path, title, mtime_unix, size_bytes, checksum_sha256, created_at, updated_at, body_fts, tag_names_fts, birthtime_unix
         FROM notes WHERE path = ?`,
		canonicalPath).Scan(&idStr, &path, &title, &mtime, &size, &checksum, &createdAt, &updatedAt, &bodyFTS, &tagNamesFTS, &birthtimeUnix)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return notes.NoteRecord{}, fmt.Errorf("LookupByPath(%q): %w", canonicalPath, notes.ErrNotFound)
		}
		return notes.NoteRecord{}, fmt.Errorf("LookupByPath(%q): %w", canonicalPath, err)
	}
	id, err := uuid.Parse(idStr)
	if err != nil {
		return notes.NoteRecord{}, fmt.Errorf("LookupByPath(%q): parse uuid %q: %w", canonicalPath, idStr, err)
	}
	return notes.NoteRecord{
		ID:            id,
		Path:          path,
		Title:         title,
		MTimeUnix:     mtime,
		SizeBytes:     size,
		Checksum:      checksum,
		UpdatedAtUnix: updatedAt,
		BodyFTS:       bodyFTS,
		TagNamesFTS:   tagNamesFTS,
		BirthtimeUnix: birthtimeUnix,
	}, nil
}

// MovePathPrefix updates every notes row whose path starts with oldPrefix
// to start with newPrefix instead. Used by Service.MoveFolder to
// recursively re-canonicalize every note under a renamed folder in one
// BEGIN IMMEDIATE transaction. Returns the count of updated rows.
//
// Returns notes.ErrCaseCollision if any row already lives under newPrefix
// AND that row is NOT itself under oldPrefix (i.e. a foreign note would
// collide on rename). The destination contents that ARE under oldPrefix
// are the ones being moved — we must not mistake them for a collision
// against themselves (consider MovePathPrefix("a/", "a/") — degenerate
// no-op, never collides).
//
// LIKE-escape note: SQLite LIKE treats `%` and `_` as wildcards. Canonical
// paths can contain `_` legitimately (a valid filename character) and
// theoretically `%` (filenames are bytes; canonical form does not strip
// `%`). The ESCAPE '\' clause + escapeLike() ensures `_` and `%` in the
// prefix bind as literal characters.
func (x *Indexer) MovePathPrefix(ctx context.Context, oldPrefix, newPrefix string) (int, error) {
	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return 0, fmt.Errorf("MovePathPrefix begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	escapedOld := escapeLike(oldPrefix)
	escapedNew := escapeLike(newPrefix)

	var collisions int
	err = tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes WHERE path LIKE ? || '%' ESCAPE '\' AND path NOT LIKE ? || '%' ESCAPE '\'`,
		escapedNew, escapedOld).Scan(&collisions)
	if err != nil {
		return 0, fmt.Errorf("MovePathPrefix collision check: %w", err)
	}
	if collisions > 0 {
		return 0, fmt.Errorf("MovePathPrefix(%q→%q): %w", oldPrefix, newPrefix, notes.ErrCaseCollision)
	}

	if err := ctx.Err(); err != nil {
		return 0, err
	}

	now := x.nowUnix()
	res, err := tx.ExecContext(ctx,
		`UPDATE notes SET path = ? || SUBSTR(path, LENGTH(?) + 1), updated_at = ?
         WHERE path LIKE ? || '%' ESCAPE '\'`,
		newPrefix, oldPrefix, now, escapedOld)
	if err != nil {
		return 0, fmt.Errorf("MovePathPrefix exec: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("MovePathPrefix rowsaffected: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("MovePathPrefix commit: %w", err)
	}
	return int(affected), nil
}

// DeleteByPathPrefix removes every row whose path starts with prefix
// (treated as a folder root). Matches both the bare prefix (e.g.
// "trash") AND children "trash/...". The empty prefix means "all rows" —
// used by Path 2 (RebuildAndReindex) drop-and-rebuild. Returns the count
// of deleted rows.
//
// LIKE-escape applied to `prefix` to neutralize `_` / `%` wildcards.
func (x *Indexer) DeleteByPathPrefix(ctx context.Context, prefix string) (int, error) {
	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return 0, fmt.Errorf("DeleteByPathPrefix begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var res sql.Result
	if prefix == "" {
		res, err = tx.ExecContext(ctx, `DELETE FROM notes`)
	} else {
		escaped := escapeLike(prefix)
		res, err = tx.ExecContext(ctx,
			`DELETE FROM notes WHERE path = ? OR path LIKE ? || '/%' ESCAPE '\'`,
			prefix, escaped)
	}
	if err != nil {
		return 0, fmt.Errorf("DeleteByPathPrefix exec: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("DeleteByPathPrefix rowsaffected: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("DeleteByPathPrefix commit: %w", err)
	}
	return int(affected), nil
}

// SearchTitles returns up to limit notes whose title contains q
// (case-insensitive LIKE match) ordered by mtime_unix DESC (recency).
// When q is empty, returns the most-recent notes up to limit.
// limit is clamped to [1, 50] by the caller; the SQL LIMIT is applied here.
//
// Returns []notes.SearchResult — a lightweight projection (id, title, path, mtime_unix).
func (x *Indexer) SearchTitles(ctx context.Context, q string, limit int) ([]notes.SearchResult, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if q == "" {
		rows, err = x.Pair.Reader.QueryContext(ctx,
			`SELECT id, title, path, mtime_unix FROM notes ORDER BY mtime_unix DESC LIMIT ?`,
			limit)
	} else {
		pattern := "%" + escapeLike(strings.ToLower(q)) + "%"
		rows, err = x.Pair.Reader.QueryContext(ctx,
			`SELECT id, title, path, mtime_unix FROM notes WHERE LOWER(title) LIKE ? ESCAPE '\' ORDER BY mtime_unix DESC LIMIT ?`,
			pattern, limit)
	}
	if err != nil {
		return nil, fmt.Errorf("searchtitles query: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []notes.SearchResult{}
	for rows.Next() {
		var idStr, title, path string
		var mtime int64
		if err := rows.Scan(&idStr, &title, &path, &mtime); err != nil {
			return nil, fmt.Errorf("searchtitles scan: %w", err)
		}
		id, err := uuid.Parse(idStr)
		if err != nil {
			return nil, fmt.Errorf("searchtitles parse uuid %q: %w", idStr, err)
		}
		out = append(out, notes.SearchResult{
			ID:        id,
			Title:     title,
			Path:      path,
			MtimeUnix: mtime,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("searchtitles rows: %w", err)
	}
	return out, nil
}

func prefixWrap(q string) string {
	trimmed := strings.TrimSpace(q)
	if trimmed == "" {
		return ""
	}

	if strings.ContainsAny(trimmed, `"():`) {
		return q
	}
	if fts5OperatorKeywordRE.MatchString(trimmed) {
		return q
	}

	tokens := strings.Fields(trimmed)
	for i, tok := range tokens {
		if strings.ContainsAny(tok, "-_") {
			tokens[i] = `"` + strings.TrimSuffix(tok, "*") + `"`
			continue
		}
		if !strings.HasSuffix(tok, "*") {
			tokens[i] = tok + "*"
		}
	}
	return strings.Join(tokens, " ")
}

// maxTagFilters caps the number of ANDed tag EXISTS clauses SearchFTS and
// searchTitlePathLike will build per query (T-19-03: defensive DoS guard).
const maxTagFilters = 8

// buildTagClauses builds one bound `AND EXISTS (...)` clause per non-empty
// tag in tags (capped at maxTagFilters, empties dropped), using positional
// bind placeholders starting at startIdx. It returns the SQL fragment to
// splice into the query and the ordered bind args for those placeholders.
//
// Security: only the fixed clause shape (SQL keywords, table/column names)
// is concatenated into the query text — every tag VALUE is appended to the
// returned args slice and bound positionally (?N), never interpolated.
func buildTagClauses(tags []string, startIdx int) (string, []any) {
	var clauses []string
	var args []any
	idx := startIdx
	for _, tagName := range tags {
		if tagName == "" {
			continue
		}
		if len(clauses) >= maxTagFilters {
			break
		}
		clauses = append(clauses, fmt.Sprintf(`
		  AND EXISTS (
		      SELECT 1 FROM note_tags nt
		      JOIN tags t ON t.id = nt.tag_id
		      WHERE nt.note_id = n.id AND t.name = ?%d
		  )`, idx))
		args = append(args, tagName)
		idx++
	}
	return strings.Join(clauses, ""), args
}

// searchOrderClause returns the hardcoded ORDER BY fragment for the given
// sort value. The raw `sort` string is NEVER interpolated into SQL — only
// one of these fixed literal fragments is ever spliced into a query
// (T-29-06: same discipline as the MATCH ?1 positional-bind contract above).
func searchOrderClause(sort string) string {
	switch sort {
	case "modified":
		return "n.updated_at DESC"
	case "created":
		return "COALESCE(NULLIF(n.birthtime_unix, 0), n.created_at) DESC"
	default: // "relevance" or "" — existing bm25 + recency blend
		return "bm25(notes_fts) + (julianday('now') - julianday(datetime(n.updated_at,'unixepoch'))) * 0.002"
	}
}

// SearchFTS runs an FTS5 MATCH query against the notes_fts virtual table with
// optional AND-combined tag filters. sort selects the ORDER BY (D-14: the
// SQL-level order runs BEFORE the LIMIT, so "modified"/"created" reflect the
// true full match set, not a client reshuffle of a relevance top-N):
//   - "relevance" (default/""): bm25 + recency blend
//   - "modified": n.updated_at DESC
//   - "created": COALESCE(NULLIF(n.birthtime_unix, 0), n.created_at) DESC
//
// Security: the MATCH clause always uses a positional bind parameter (?1) —
// NEVER string concatenation. The ORDER BY is chosen by searchOrderClause's
// closed switch over hardcoded literals — the raw sort string never reaches
// the query text.
//
// FTS5 syntax errors (unbalanced parentheses, etc.) are caught and wrapped as
// notes.ErrFTSQuerySyntax so the handler maps to HTTP 400.
func (x *Indexer) SearchFTS(ctx context.Context, q string, tags []string, limit int, sort string) ([]notes.SearchHit, error) {
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}

	// An empty (or whitespace-only) q cannot be passed to notes_fts MATCH —
	// `notes_fts MATCH ''` is an FTS5 syntax error. D-24: a bare tag:name
	// query still needs to work, so route empty-q requests through a
	// non-FTS tag-only lookup instead of the MATCH path below.
	if strings.TrimSpace(q) == "" {
		return x.searchTagsOnly(ctx, tags, limit, sort)
	}

	tagClauseSQL, tagArgs := buildTagClauses(tags, 2)
	limitIdx := 2 + len(tagArgs)

	sqlText := fmt.Sprintf(`
		SELECT
			n.id,
			n.title,
			n.path,
			n.updated_at,
			COALESCE(NULLIF(n.birthtime_unix, 0), n.created_at),
			snippet(notes_fts, 0, '<mark>', '</mark>', '…', 24) AS excerpt_html,
			bm25(notes_fts) AS rank
		FROM notes_fts
		JOIN notes n ON notes_fts.rowid = n.rowid
		WHERE notes_fts MATCH ?1
		%s
		ORDER BY %s
		LIMIT ?%d
	`, tagClauseSQL, searchOrderClause(sort), limitIdx)

	matchQuery := prefixWrap(q)

	args := make([]any, 0, 2+len(tagArgs))
	args = append(args, matchQuery)
	args = append(args, tagArgs...)
	args = append(args, limit+1)

	rows, err := x.Pair.Reader.QueryContext(ctx, sqlText, args...)
	if err != nil {
		if strings.Contains(err.Error(), "fts5: syntax error") {
			return nil, fmt.Errorf("%w: %v", notes.ErrFTSQuerySyntax, err)
		}
		return nil, fmt.Errorf("searchfts query: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var hits []notes.SearchHit
	for rows.Next() {
		var h notes.SearchHit
		var updatedAt, createdAt int64
		if err := rows.Scan(&h.ID, &h.Title, &h.Path, &updatedAt, &createdAt, &h.ExcerptHTML, &h.Rank); err != nil {
			return nil, fmt.Errorf("searchfts scan: %w", err)
		}
		h.ModifiedAt = time.Unix(updatedAt, 0).UTC()
		h.CreatedAt = time.Unix(createdAt, 0).UTC()
		hits = append(hits, h)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("searchfts iter: %w", err)
	}

	// Pitfall 4 (RESEARCH): the title-LIKE fallback appends rows in its own
	// order, which would reshuffle the SQL-level modified/created ordering
	// above. Skip it entirely for time sorts — D-14's "no reshuffle"
	// contract only needs the relevance path to backfill via LIKE.
	trimmed := strings.TrimSpace(q)
	isRelevanceSort := sort == "" || sort == "relevance"
	if isRelevanceSort && trimmed != "" && !strings.ContainsAny(trimmed, `"():`) && !fts5OperatorKeywordRE.MatchString(trimmed) && len(hits) <= limit {
		existing := make(map[string]bool, len(hits))
		for _, h := range hits {
			existing[h.ID] = true
		}
		need := limit + 1 - len(hits)
		if need > 0 {
			likeHits, lerr := x.searchTitlePathLike(ctx, trimmed, tags, existing, need)
			if lerr != nil {
				x.Log.Warn("searchfts: title-LIKE fallback failed (continuing with FTS-only)", "err", lerr)
			} else {
				hits = append(hits, likeHits...)
			}
		}
	}

	for i := range hits {
		tagNames, terr := x.tagNamesForNote(ctx, hits[i].ID)
		if terr != nil {
			x.Log.Error("searchfts: tagNamesForNote", "note_id", hits[i].ID, "err", terr)
			continue
		}
		hits[i].MatchingTags = tagNames
	}
	return hits, nil
}

// searchTagsOnly serves a pure tag-filter query (empty or whitespace-only q)
// by listing notes matching ALL given tags directly from the notes table,
// bypassing FTS5 MATCH entirely (D-24). No snippet is available without a
// MATCH, so ExcerptHTML stays empty on every hit. If tags yields zero
// non-empty clauses, returns (nil, nil) — an unfiltered empty-q dump would be
// an information-disclosure risk (T-SM6-03), so there is nothing to list.
// sort follows the same closed set as SearchFTS (D-14 parity for the
// empty-q branch); this path has no bm25 rank so "relevance" here falls
// back to n.updated_at DESC (its prior behavior), same as "modified".
func (x *Indexer) searchTagsOnly(ctx context.Context, tags []string, limit int, sort string) ([]notes.SearchHit, error) {
	tagClauseSQL, tagArgs := buildTagClauses(tags, 1)
	if len(tagArgs) == 0 {
		return nil, nil
	}
	limitIdx := 1 + len(tagArgs)

	orderClause := "n.updated_at DESC"
	if sort == "created" {
		orderClause = "COALESCE(NULLIF(n.birthtime_unix, 0), n.created_at) DESC"
	}

	sqlText := fmt.Sprintf(`
		SELECT n.id, n.title, n.path, n.updated_at, COALESCE(NULLIF(n.birthtime_unix, 0), n.created_at)
		FROM notes n
		WHERE 1=1
		%s
		ORDER BY %s
		LIMIT ?%d
	`, tagClauseSQL, orderClause, limitIdx)

	args := make([]any, 0, len(tagArgs)+1)
	args = append(args, tagArgs...)
	args = append(args, limit)

	rows, err := x.Pair.Reader.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil, fmt.Errorf("searchtagsonly query: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var hits []notes.SearchHit
	for rows.Next() {
		var h notes.SearchHit
		var updatedAt, createdAt int64
		if err := rows.Scan(&h.ID, &h.Title, &h.Path, &updatedAt, &createdAt); err != nil {
			return nil, fmt.Errorf("searchtagsonly scan: %w", err)
		}
		h.ModifiedAt = time.Unix(updatedAt, 0).UTC()
		h.CreatedAt = time.Unix(createdAt, 0).UTC()
		hits = append(hits, h)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("searchtagsonly iter: %w", err)
	}

	for i := range hits {
		tagNames, terr := x.tagNamesForNote(ctx, hits[i].ID)
		if terr != nil {
			x.Log.Error("searchtagsonly: tagNamesForNote", "note_id", hits[i].ID, "err", terr)
			continue
		}
		hits[i].MatchingTags = tagNames
	}
	return hits, nil
}

func (x *Indexer) searchTitlePathLike(
	ctx context.Context,
	q string, tags []string,
	existing map[string]bool,
	limit int,
) ([]notes.SearchHit, error) {
	tagClauseSQL, tagArgs := buildTagClauses(tags, 2)
	limitIdx := 2 + len(tagArgs)

	sqlText := fmt.Sprintf(`
		SELECT n.id, n.title, n.path, n.updated_at, COALESCE(NULLIF(n.birthtime_unix, 0), n.created_at)
		FROM notes n
		WHERE (n.title LIKE '%%' || ?1 || '%%' OR n.path LIKE '%%' || ?1 || '%%')
		%s
		ORDER BY n.updated_at DESC
		LIMIT ?%d
	`, tagClauseSQL, limitIdx)

	overFetch := limit + len(existing) + 10

	args := make([]any, 0, 2+len(tagArgs))
	args = append(args, q)
	args = append(args, tagArgs...)
	args = append(args, overFetch)

	rows, err := x.Pair.Reader.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil, fmt.Errorf("searchlike query: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var hits []notes.SearchHit
	for rows.Next() {
		if len(hits) >= limit {
			break
		}
		var h notes.SearchHit
		var updatedAt, createdAt int64
		if err := rows.Scan(&h.ID, &h.Title, &h.Path, &updatedAt, &createdAt); err != nil {
			return nil, fmt.Errorf("searchlike scan: %w", err)
		}
		if existing[h.ID] {
			continue
		}
		h.ModifiedAt = time.Unix(updatedAt, 0).UTC()
		h.CreatedAt = time.Unix(createdAt, 0).UTC()
		h.Rank = 999
		hits = append(hits, h)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("searchlike iter: %w", err)
	}
	return hits, nil
}

func (x *Indexer) tagNamesForNote(ctx context.Context, noteID string) ([]string, error) {
	rows, err := x.Pair.Reader.QueryContext(ctx,
		`SELECT t.name FROM tags t JOIN note_tags nt ON t.id = nt.tag_id WHERE nt.note_id = ? ORDER BY t.name`,
		noteID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		names = append(names, n)
	}
	return names, rows.Err()
}

func escapeLike(s string) string {
	r := strings.NewReplacer(
		`\`, `\\`,
		`%`, `\%`,
		`_`, `\_`,
	)
	return r.Replace(s)
}

type existingRow struct {
	ID    uuid.UUID
	MTime int64
}

func (x *Indexer) existing(ctx context.Context) (map[string]existingRow, error) {
	rows, err := x.Pair.Reader.QueryContext(ctx, `SELECT id, path, mtime_unix FROM notes`)
	if err != nil {
		return nil, fmt.Errorf("existing query: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]existingRow{}
	for rows.Next() {
		var idStr, path string
		var mtime int64
		if err := rows.Scan(&idStr, &path, &mtime); err != nil {
			return nil, fmt.Errorf("existing scan: %w", err)
		}
		id, err := uuid.Parse(idStr)
		if err != nil {
			return nil, fmt.Errorf("existing parse uuid %q: %w", idStr, err)
		}
		out[path] = existingRow{ID: id, MTime: mtime}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("existing rows: %w", err)
	}
	return out, nil
}

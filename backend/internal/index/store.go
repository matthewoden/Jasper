package index

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

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
// without SQLITE_BUSY (DATA-03 + ROADMAP success criterion #5).
//
// `checksum_sha256` is rec.Checksum which Phase 2 ALWAYS sets to "" —
// the column exists in the schema but is populated NULL/empty for
// the entirety of Phase 2. DATA-09 checksum-fallback is deferred to
// Phase 7.
func (x *Indexer) Upsert(ctx context.Context, rec notes.NoteRecord) error {
	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return fmt.Errorf("upsert begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }() // no-op after Commit

	// Pre-check: another row with the same canonical path but a
	// different id?
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

	// INSERT … ON CONFLICT(id) DO UPDATE — idempotent upsert keyed on
	// the v4 UUID. The unique-path constraint covers different-id same-
	// path collisions which surface as a UNIQUE constraint failure
	// (caught below).
	// body_fts and tag_names_fts are the FTS5 index columns added in
	// migration 003_fts.sql (Plan 07-02). The notes_fts_ai/au triggers
	// propagate these values into the notes_fts virtual table automatically.
	_, err = tx.ExecContext(ctx,
		`INSERT INTO notes(id, path, title, mtime_unix, size_bytes, checksum_sha256, created_at, updated_at, body_fts, tag_names_fts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
             path = excluded.path,
             title = excluded.title,
             mtime_unix = excluded.mtime_unix,
             size_bytes = excluded.size_bytes,
             checksum_sha256 = excluded.checksum_sha256,
             updated_at = excluded.updated_at,
             body_fts = excluded.body_fts,
             tag_names_fts = excluded.tag_names_fts`,
		rec.ID.String(), rec.Path, rec.Title, rec.MTimeUnix,
		rec.SizeBytes, rec.Checksum, rec.UpdatedAtUnix, rec.UpdatedAtUnix,
		rec.BodyFTS, rec.TagNamesFTS)
	if err != nil {
		// SQLite's UNIQUE-constraint message format is stable:
		//   "UNIQUE constraint failed: notes.path"
		// Catch it here for the race-window case (concurrent inserts
		// landing the same path between our SELECT and INSERT).
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
// The UI shows file-relevant timestamps; the index-touch time is
// internal-only (T-02-04a-02 mitigation — Checksum / UpdatedAtUnix
// never escape the package).
func (x *Indexer) List(ctx context.Context) ([]notes.NoteSummary, error) {
	rows, err := x.Pair.Reader.QueryContext(ctx,
		`SELECT id, path, title, mtime_unix FROM notes ORDER BY path ASC`)
	if err != nil {
		return nil, fmt.Errorf("list query: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []notes.NoteSummary
	for rows.Next() {
		var idStr, path, title string
		var mtime int64
		if err := rows.Scan(&idStr, &path, &title, &mtime); err != nil {
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
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list rows: %w", err)
	}
	return out, nil
}

// LookupByPath finds a NoteRecord by its canonical relative path. Returns
// notes.ErrNotFound when no row matches. Phase 3 Plan 03-03 addition.
//
// Reads via Pair.Reader (no transaction — pure read). Used by
// Service.Move to look up the existing record before issuing the rename
// (so the same UUID stays attached to the moved file).
func (x *Indexer) LookupByPath(ctx context.Context, canonicalPath string) (notes.NoteRecord, error) {
	var (
		idStr, path, title, checksum      string
		mtime, size, createdAt, updatedAt int64
	)
	err := x.Pair.Reader.QueryRowContext(ctx,
		`SELECT id, path, title, mtime_unix, size_bytes, checksum_sha256, created_at, updated_at
         FROM notes WHERE path = ?`,
		canonicalPath).Scan(&idStr, &path, &title, &mtime, &size, &checksum, &createdAt, &updatedAt)
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
// prefix bind as literal characters. T-03-03-03 mitigation.
func (x *Indexer) MovePathPrefix(ctx context.Context, oldPrefix, newPrefix string) (int, error) {
	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return 0, fmt.Errorf("MovePathPrefix begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }() // no-op after Commit

	escapedOld := escapeLike(oldPrefix)
	escapedNew := escapeLike(newPrefix)

	// Collision precheck: any row whose path starts with newPrefix BUT
	// does not also start with oldPrefix is a foreign collision.
	// (If newPrefix == oldPrefix, every row matches both filters, so n=0
	// and no collision is reported — the move becomes a no-op.)
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

	// Honor cancellation between SQL ops.
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
// Returns []notes.SearchResult — a lightweight projection (id, title, path,
// mtime_unix) used by GetNotesSearchTitles (LINKS-06 / D-13).
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

// SearchFTS runs an FTS5 MATCH query against the notes_fts virtual table with
// an optional AND-combined tag filter. Results are ordered by the bm25 +
// recency blend described in RESEARCH.md §bm25() × Recency SQL (D-03/D-46).
//
// Security: the MATCH clause always uses a positional bind parameter (?1) —
// NEVER fmt.Sprintf or string concatenation (T-7-08 mitigation).
//
// FTS5 syntax errors (unbalanced parentheses, etc.) are caught by
// strings.Contains on the error message and wrapped as notes.ErrFTSQuerySyntax
// so the handler maps to HTTP 400 (T-7-10 mitigation, Pitfall 2).
func (x *Indexer) SearchFTS(ctx context.Context, q, tag string, limit int) ([]notes.SearchHit, error) {
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}

	// Positional bind parameters required here because ?2 appears twice in
	// the WHERE clause (gate: ?2 IS NULL OR t.id IS NOT NULL).
	const sqlText = `
		SELECT
			n.id,
			n.title,
			n.path,
			n.updated_at,
			snippet(notes_fts, 0, '<mark>', '</mark>', '…', 24) AS excerpt_html,
			bm25(notes_fts) AS rank
		FROM notes_fts
		JOIN notes n ON notes_fts.rowid = n.rowid
		LEFT JOIN note_tags nt ON nt.note_id = n.id
		LEFT JOIN tags t ON t.id = nt.tag_id AND t.name = ?2
		WHERE notes_fts MATCH ?1
		  AND (?2 IS NULL OR t.id IS NOT NULL)
		GROUP BY n.id
		ORDER BY
			bm25(notes_fts) + (julianday('now') - julianday(datetime(n.updated_at,'unixepoch'))) * 0.002
		LIMIT ?3
	`

	var tagBind any
	if tag != "" {
		tagBind = tag
	}

	rows, err := x.Pair.Reader.QueryContext(ctx, sqlText, q, tagBind, limit+1)
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
		var updatedAt int64
		if err := rows.Scan(&h.ID, &h.Title, &h.Path, &updatedAt, &h.ExcerptHTML, &h.Rank); err != nil {
			return nil, fmt.Errorf("searchfts scan: %w", err)
		}
		h.ModifiedAt = time.Unix(updatedAt, 0).UTC()
		hits = append(hits, h)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("searchfts iter: %w", err)
	}

	// Populate MatchingTags via per-hit lookup. Cheap because limit ≤ 100.
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

// tagNamesForNote returns the sorted tag names for noteID. Used by SearchFTS
// to populate SearchHit.MatchingTags after the FTS query.
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

// escapeLike escapes the SQLite LIKE wildcards `%` and `_` (and the
// escape character itself, `\`) so the supplied prefix binds as a
// literal substring under `LIKE ? ESCAPE '\'`. Without this, an
// underscore in a path segment (a valid filename character) would
// silently match any single character, and a literal `%` would match
// any substring. T-03-03-03 mitigation.
func escapeLike(s string) string {
	// Order matters: escape the escape character first, then the wildcards,
	// otherwise we'd double-escape the backslashes we just inserted.
	r := strings.NewReplacer(
		`\`, `\\`,
		`%`, `\%`,
		`_`, `\_`,
	)
	return r.Replace(s)
}

// existingRow is the per-row projection used by reconcile to decide
// whether a freshly-walked file is new / unchanged / dirty.
type existingRow struct {
	ID    uuid.UUID
	MTime int64
}

// existing returns a map of canonical path → (id, mtime_unix) for every
// row in `notes`. Used by Reconcile to compute the disk-vs-index delta
// in O(N) without round-tripping per-file SELECTs.
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

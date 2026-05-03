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
	_, err = tx.ExecContext(ctx,
		`INSERT INTO notes(id, path, title, mtime_unix, size_bytes, checksum_sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
             path = excluded.path,
             title = excluded.title,
             mtime_unix = excluded.mtime_unix,
             size_bytes = excluded.size_bytes,
             checksum_sha256 = excluded.checksum_sha256,
             updated_at = excluded.updated_at`,
		rec.ID.String(), rec.Path, rec.Title, rec.MTimeUnix,
		rec.SizeBytes, rec.Checksum, rec.UpdatedAtUnix, rec.UpdatedAtUnix)
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

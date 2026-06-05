package index

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// TagWithCount is an alias of notes.TagWithCount. Kept here for backward
// compatibility; callers can use either index.TagWithCount or notes.TagWithCount.
type TagWithCount = notes.TagWithCount

var (
	// ErrTagNotFound is an alias for notes.ErrTagNotFound.
	ErrTagNotFound = notes.ErrTagNotFound

	// ErrTagCollision is an alias for notes.ErrTagCollision.
	ErrTagCollision = notes.ErrTagCollision

	// ErrInvalidTagName is an alias for notes.ErrInvalidTagName.
	ErrInvalidTagName = notes.ErrInvalidTagName
)

var validTagRE = regexp.MustCompile(`^[a-z0-9_-]+$`)

// SyncTags upserts the tag vocabulary and replaces every note_tags row for
// noteID in a single BEGIN IMMEDIATE transaction. Orphan tags (tags whose
// last note_tags row was removed) are deleted inside the same transaction
// (D-05 immediate cleanup).
//
// Passing nil or an empty slice is equivalent: all tags for the note are
// removed and orphans cleaned up.
//
// Tags are assumed to already be normalized by the caller (lowercase, D-22
// charset). Duplicate entries in the input slice are de-duplicated before
// insertion; ON CONFLICT(name) DO NOTHING guards against race-window
// re-insertion.
func (x *Indexer) SyncTags(ctx context.Context, noteID uuid.UUID, tags []string) error {
	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return fmt.Errorf("synctags begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM note_tags WHERE note_id = ?`, noteID.String()); err != nil {
		return fmt.Errorf("synctags clear: %w", err)
	}

	seen := make(map[string]bool, len(tags))
	for _, tag := range tags {
		if tag == "" || seen[tag] {
			continue
		}
		seen[tag] = true

		if _, err := tx.ExecContext(ctx,
			`INSERT INTO tags(name) VALUES(?) ON CONFLICT(name) DO NOTHING`, tag); err != nil {
			return fmt.Errorf("synctags upsert tag %q: %w", tag, err)
		}

		if _, err := tx.ExecContext(ctx,
			`INSERT INTO note_tags(note_id, tag_id)
			 SELECT ?, id FROM tags WHERE name = ?`,
			noteID.String(), tag); err != nil {
			return fmt.Errorf("synctags insert note_tags %q: %w", tag, err)
		}
	}

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM note_tags)`); err != nil {
		return fmt.Errorf("synctags orphan cleanup: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("synctags commit: %w", err)
	}
	return nil
}

// ListTags returns all tags that have at least one carrier note, sorted
// alphabetically by name (D-03). The count reflects how many notes carry
// each tag at the time of the query.
//
// Returns a non-nil empty slice (not nil) when no tags exist.
func (x *Indexer) ListTags(ctx context.Context) ([]notes.TagWithCount, error) {
	rows, err := x.Pair.Reader.QueryContext(ctx,
		`SELECT t.name, COUNT(nt.note_id) AS cnt
		 FROM tags t
		 INNER JOIN note_tags nt ON nt.tag_id = t.id
		 GROUP BY t.id
		 ORDER BY t.name ASC`)
	if err != nil {
		return nil, fmt.Errorf("listtags query: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []notes.TagWithCount{}
	for rows.Next() {
		var tw notes.TagWithCount
		if err := rows.Scan(&tw.Name, &tw.Count); err != nil {
			return nil, fmt.Errorf("listtags scan: %w", err)
		}
		out = append(out, tw)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("listtags rows: %w", err)
	}
	return out, nil
}

// NotesByTag returns a NoteSummary for every note carrying the named tag,
// ordered by mtime descending (D-28 recency sort). Returns a non-nil empty
// slice (not nil) when the tag has no carriers — 404 logic is the handler's
// responsibility.
func (x *Indexer) NotesByTag(ctx context.Context, name string) ([]notes.NoteSummary, error) {
	rows, err := x.Pair.Reader.QueryContext(ctx,
		`SELECT n.id, n.path, n.title, n.mtime_unix
		 FROM notes n
		 INNER JOIN note_tags nt ON nt.note_id = n.id
		 INNER JOIN tags t ON t.id = nt.tag_id
		 WHERE t.name = ?
		 ORDER BY n.mtime_unix DESC`,
		name)
	if err != nil {
		return nil, fmt.Errorf("notesbytag query: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []notes.NoteSummary{}
	for rows.Next() {
		var idStr, path, title string
		var mtime int64
		if err := rows.Scan(&idStr, &path, &title, &mtime); err != nil {
			return nil, fmt.Errorf("notesbytag scan: %w", err)
		}
		id, err := uuid.Parse(idStr)
		if err != nil {
			return nil, fmt.Errorf("notesbytag parse uuid %q: %w", idStr, err)
		}
		out = append(out, notes.NoteSummary{
			ID:        id,
			Path:      path,
			Title:     title,
			UpdatedAt: time.Unix(mtime, 0).UTC(),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("notesbytag rows: %w", err)
	}
	return out, nil
}

// RenameTag atomically renames a tag from oldName to newName and returns the
// UUIDs of all notes that carried the tag (so callers can build the
// tags:rewritten WS payload). The tag_id is NOT changed — only tags.name is
// updated — so all note_tags rows remain valid.
//
// Returns:
//   - ErrTagNotFound if oldName does not exist
//   - ErrTagCollision if newName already exists
//   - ErrInvalidTagName if newName violates D-22 charset
func (x *Indexer) RenameTag(ctx context.Context, oldName, newName string) ([]uuid.UUID, error) {
	if !validTagRE.MatchString(newName) {
		return nil, ErrInvalidTagName
	}

	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return nil, fmt.Errorf("renametag begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var tagID int64
	err = tx.QueryRowContext(ctx,
		`SELECT id FROM tags WHERE name = ?`, oldName).Scan(&tagID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrTagNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("renametag lookup old: %w", err)
	}

	var existingID int64
	err = tx.QueryRowContext(ctx,
		`SELECT id FROM tags WHERE name = ?`, newName).Scan(&existingID)
	if err == nil {
		return nil, ErrTagCollision
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("renametag collision check: %w", err)
	}

	noteIDs, err := tagNoteIDs(ctx, tx, tagID)
	if err != nil {
		return nil, fmt.Errorf("renametag collect ids: %w", err)
	}

	if _, err := tx.ExecContext(ctx,
		`UPDATE tags SET name = ? WHERE id = ?`, newName, tagID); err != nil {
		return nil, fmt.Errorf("renametag update: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("renametag commit: %w", err)
	}
	return noteIDs, nil
}

// DeleteTag atomically removes a tag and all its note_tags rows (via ON
// DELETE CASCADE in the schema) and returns the UUIDs of the notes that
// carried the tag (for the tags:rewritten WS payload).
//
// Returns ErrTagNotFound if the tag does not exist.
func (x *Indexer) DeleteTag(ctx context.Context, name string) ([]uuid.UUID, error) {
	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return nil, fmt.Errorf("deletetag begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var tagID int64
	err = tx.QueryRowContext(ctx,
		`SELECT id FROM tags WHERE name = ?`, name).Scan(&tagID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrTagNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("deletetag lookup: %w", err)
	}

	noteIDs, err := tagNoteIDs(ctx, tx, tagID)
	if err != nil {
		return nil, fmt.Errorf("deletetag collect ids: %w", err)
	}

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM tags WHERE id = ?`, tagID); err != nil {
		return nil, fmt.Errorf("deletetag delete: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("deletetag commit: %w", err)
	}
	return noteIDs, nil
}

func tagNoteIDs(ctx context.Context, tx *sql.Tx, tagID int64) ([]uuid.UUID, error) {
	rows, err := tx.QueryContext(ctx,
		`SELECT note_id FROM note_tags WHERE tag_id = ?`, tagID)
	if err != nil {
		return nil, fmt.Errorf("tagNoteIDs query: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []uuid.UUID
	for rows.Next() {
		var idStr string
		if err := rows.Scan(&idStr); err != nil {
			return nil, fmt.Errorf("tagNoteIDs scan: %w", err)
		}
		id, err := uuid.Parse(idStr)
		if err != nil {
			return nil, fmt.Errorf("tagNoteIDs parse uuid %q: %w", idStr, err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("tagNoteIDs rows: %w", err)
	}
	return out, nil
}

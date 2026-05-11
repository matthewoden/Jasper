package index

// tags.go — Plan 06-04 Task 2: SyncTags, ListTags, NotesByTag, RenameTag,
// DeleteTag and their associated exported types + sentinel errors.
//
// All write methods use BEGIN IMMEDIATE transactions per DATA-03 single-writer
// constraint (matches the existing Upsert + Delete + MovePathPrefix pattern in
// store.go).

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

// ---------------------------------------------------------------------------
// Wire-shape types
// ---------------------------------------------------------------------------

// TagWithCount is the projection returned by ListTags.
// Matches the TagWithCount component schema in api/openapi.yaml (Plan 06-02).
type TagWithCount struct {
	Name  string
	Count int
}

// ---------------------------------------------------------------------------
// Sentinel errors
// ---------------------------------------------------------------------------

var (
	// ErrTagNotFound is returned by RenameTag and DeleteTag when the named
	// tag does not exist. Handlers map this to HTTP 404.
	ErrTagNotFound = errors.New("tag not found")

	// ErrTagCollision is returned by RenameTag when newName already exists.
	// Handlers map this to HTTP 409 Conflict.
	ErrTagCollision = errors.New("tag already exists")

	// ErrInvalidTagName is returned by RenameTag when the supplied newName
	// contains characters not allowed by D-22 ([a-z0-9_-]+).
	ErrInvalidTagName = errors.New("invalid tag name")
)

// validTagRE matches the D-22 charset: lowercase letters, digits, hyphens,
// underscores only. The RenameTag store layer enforces this even though the
// handler validates first (defense-in-depth per T-06-04-02).
var validTagRE = regexp.MustCompile(`^[a-z0-9_-]+$`)

// ---------------------------------------------------------------------------
// SyncTags
// ---------------------------------------------------------------------------

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

	// 1. Delete all existing note_tags for this note (we rewrite the full set).
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM note_tags WHERE note_id = ?`, noteID.String()); err != nil {
		return fmt.Errorf("synctags clear: %w", err)
	}

	// 2. Upsert each tag and re-insert the note_tags row.
	// De-duplicate the input to avoid PRIMARY KEY violation.
	seen := make(map[string]bool, len(tags))
	for _, tag := range tags {
		if tag == "" || seen[tag] {
			continue
		}
		seen[tag] = true

		// Upsert the tag — ON CONFLICT(name) DO NOTHING keeps existing id.
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO tags(name) VALUES(?) ON CONFLICT(name) DO NOTHING`, tag); err != nil {
			return fmt.Errorf("synctags upsert tag %q: %w", tag, err)
		}
		// Insert the join row via SELECT to get the canonical tag_id.
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO note_tags(note_id, tag_id)
			 SELECT ?, id FROM tags WHERE name = ?`,
			noteID.String(), tag); err != nil {
			return fmt.Errorf("synctags insert note_tags %q: %w", tag, err)
		}
	}

	// 3. Orphan cleanup (D-05): delete tags with zero note_tags referrers.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM note_tags)`); err != nil {
		return fmt.Errorf("synctags orphan cleanup: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("synctags commit: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// ListTags
// ---------------------------------------------------------------------------

// ListTags returns all tags that have at least one carrier note, sorted
// alphabetically by name (D-03). The count reflects how many notes carry
// each tag at the time of the query.
//
// Returns a non-nil empty slice (not nil) when no tags exist.
func (x *Indexer) ListTags(ctx context.Context) ([]TagWithCount, error) {
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

	out := []TagWithCount{} // non-nil empty slice per contract
	for rows.Next() {
		var tw TagWithCount
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

// ---------------------------------------------------------------------------
// NotesByTag
// ---------------------------------------------------------------------------

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

	out := []notes.NoteSummary{} // non-nil empty slice per contract
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

// ---------------------------------------------------------------------------
// RenameTag
// ---------------------------------------------------------------------------

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

	// Look up oldName → tag_id.
	var tagID int64
	err = tx.QueryRowContext(ctx,
		`SELECT id FROM tags WHERE name = ?`, oldName).Scan(&tagID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrTagNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("renametag lookup old: %w", err)
	}

	// Check for collision: does newName already exist?
	var existingID int64
	err = tx.QueryRowContext(ctx,
		`SELECT id FROM tags WHERE name = ?`, newName).Scan(&existingID)
	if err == nil {
		// newName exists — collision.
		return nil, ErrTagCollision
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("renametag collision check: %w", err)
	}

	// Collect referrer note_ids BEFORE renaming.
	noteIDs, err := tagNoteIDs(ctx, tx, tagID)
	if err != nil {
		return nil, fmt.Errorf("renametag collect ids: %w", err)
	}

	// Rename the tag.
	if _, err := tx.ExecContext(ctx,
		`UPDATE tags SET name = ? WHERE id = ?`, newName, tagID); err != nil {
		return nil, fmt.Errorf("renametag update: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("renametag commit: %w", err)
	}
	return noteIDs, nil
}

// ---------------------------------------------------------------------------
// DeleteTag
// ---------------------------------------------------------------------------

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

	// Look up name → tag_id.
	var tagID int64
	err = tx.QueryRowContext(ctx,
		`SELECT id FROM tags WHERE name = ?`, name).Scan(&tagID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrTagNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("deletetag lookup: %w", err)
	}

	// Collect referrer note_ids BEFORE delete (CASCADE will drop note_tags).
	noteIDs, err := tagNoteIDs(ctx, tx, tagID)
	if err != nil {
		return nil, fmt.Errorf("deletetag collect ids: %w", err)
	}

	// Delete the tag — CASCADE handles note_tags rows automatically.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM tags WHERE id = ?`, tagID); err != nil {
		return nil, fmt.Errorf("deletetag delete: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("deletetag commit: %w", err)
	}
	return noteIDs, nil
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

// tagNoteIDs queries note_tags for all note IDs that carry tagID inside an
// open transaction. Returns the parsed UUIDs.
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

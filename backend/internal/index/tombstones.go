package index

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Tombstone is what an item was when its index row went away.
type Tombstone struct {
	ID         notes.ID
	LastPath   string
	LastTitle  string
	DeletedAt  int64
	ReplacedBy notes.ID
}

// GetTombstone reports whether id was deleted and what it last was.
func (x *Indexer) GetTombstone(ctx context.Context, id notes.ID) (Tombstone, bool, error) {
	var t Tombstone
	var idStr, replacedBy sql.NullString
	err := x.Pair.Reader.QueryRowContext(ctx,
		`SELECT id, last_path, last_title, deleted_at, replaced_by FROM tombstones WHERE id = ?`,
		id.String()).Scan(&idStr, &t.LastPath, &t.LastTitle, &t.DeletedAt, &replacedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return Tombstone{}, false, nil
	}
	if err != nil {
		return Tombstone{}, false, fmt.Errorf("tombstone %s: %w", id, err)
	}
	t.ID = notes.ID(idStr.String)
	t.ReplacedBy = notes.ID(replacedBy.String)
	return t, true, nil
}

// tombstoneNotes records every notes row matching the predicate before the
// caller deletes them. Runs inside the caller's transaction.
func (x *Indexer) tombstoneNotes(ctx context.Context, tx *sql.Tx, where string, args ...any) error {
	params := append([]any{x.nowUnix()}, args...)
	_, err := tx.ExecContext(ctx,
		`INSERT OR REPLACE INTO tombstones(id, last_path, last_title, deleted_at, replaced_by)
		 SELECT id, path, title, ?, NULL FROM notes WHERE `+where, params...)
	if err != nil {
		return fmt.Errorf("tombstone: %w", err)
	}
	return nil
}

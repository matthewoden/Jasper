package index

import (
	"context"
	"fmt"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// NoteRef is one target a note references, as its first occurrence.
type NoteRef struct {
	TargetRef string
	Display   string
	Embed     bool
	Position  int
}

// RefsBySource returns the distinct targets sourceID references, in order of
// first occurrence (frontmatter entries first).
func (x *Indexer) RefsBySource(ctx context.Context, sourceID notes.ID) ([]NoteRef, error) {
	rows, err := x.Pair.Reader.QueryContext(ctx,
		`SELECT target_ref, display, embed, position FROM refs
		 WHERE source_id = ?
		   AND id = (SELECT MIN(id) FROM refs r2 WHERE r2.source_id = refs.source_id AND r2.target_ref = refs.target_ref)
		 ORDER BY id`, sourceID.String())
	if err != nil {
		return nil, fmt.Errorf("refs by source: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []NoteRef{}
	for rows.Next() {
		var r NoteRef
		var embed int
		if err := rows.Scan(&r.TargetRef, &r.Display, &embed, &r.Position); err != nil {
			return nil, fmt.Errorf("refs by source scan: %w", err)
		}
		r.Embed = embed != 0
		out = append(out, r)
	}
	return out, rows.Err()
}

package index

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// RefBacklinks returns the notes referencing targetRef, newest source
// first, one row per source carrying its first occurrence's alias and form.
func (x *Indexer) RefBacklinks(ctx context.Context, targetRef string) ([]notes.RefBacklink, error) {
	rows, err := x.Pair.Reader.QueryContext(ctx,
		`SELECT n.id, n.title, n.path, r.display, r.embed
		 FROM refs r
		 JOIN notes n ON n.id = r.source_id
		 WHERE r.target_ref = ?
		   AND r.id = (SELECT MIN(id) FROM refs WHERE source_id = r.source_id AND target_ref = r.target_ref)
		 ORDER BY n.mtime_unix DESC, n.path ASC`, targetRef)
	if err != nil {
		return nil, fmt.Errorf("ref backlinks: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []notes.RefBacklink{}
	for rows.Next() {
		var b notes.RefBacklink
		var id string
		var embed int
		if err := rows.Scan(&id, &b.SourceTitle, &b.SourcePath, &b.Display, &embed); err != nil {
			return nil, fmt.Errorf("ref backlinks scan: %w", err)
		}
		b.SourceID = notes.ID(id)
		b.Embed = embed != 0
		out = append(out, b)
	}
	return out, rows.Err()
}

const excerptRunes = 200

var headingMarkerRE = regexp.MustCompile(`(?m)^#{1,6}[ \t]+`)

// LookupItem resolves a note or blob id, bare or jasper:-prefixed. Anything
// it cannot name is UNKNOWN; anything the tombstones remember is DELETED.
func (x *Indexer) LookupItem(ctx context.Context, id string) (notes.ItemInfo, error) {
	ref, err := notes.ParseItemRef(id)
	switch {
	case err == nil && ref.Native() && ref.Kind == notes.RefKindBlob:
		return x.lookupBlobItem(ctx, id, ref.ID)
	case err == nil && ref.Native() && ref.Kind == notes.RefKindNote:
		return x.lookupNoteItem(ctx, id, ref.ID)
	default:
		return x.lookupNoteItem(ctx, id, id)
	}
}

func (x *Indexer) lookupNoteItem(ctx context.Context, requested, raw string) (notes.ItemInfo, error) {
	unknown := notes.ItemInfo{ID: requested, Kind: notes.ItemKindNote, Status: notes.ItemStatusUnknown, Title: requested}
	noteID, err := notes.ParseID(raw)
	if err != nil {
		return unknown, nil
	}
	var title, p, body string
	var mtime int64
	err = x.Pair.Reader.QueryRowContext(ctx,
		`SELECT title, path, mtime_unix, substr(body_fts, 1, 400) FROM notes WHERE id = ?`, noteID.String()).
		Scan(&title, &p, &mtime, &body)
	switch {
	case err == nil:
		return notes.ItemInfo{
			ID: requested, Kind: notes.ItemKindNote, Status: notes.ItemStatusOK,
			Title: title, Path: p, UpdatedAt: time.Unix(mtime, 0).UTC(), Excerpt: excerpt(body),
		}, nil
	case !errors.Is(err, sql.ErrNoRows):
		return notes.ItemInfo{}, fmt.Errorf("lookup note %s: %w", raw, err)
	}
	return x.deletedItem(ctx, unknown, noteID.String())
}

func (x *Indexer) lookupBlobItem(ctx context.Context, requested, blobID string) (notes.ItemInfo, error) {
	unknown := notes.ItemInfo{ID: requested, Kind: notes.ItemKindBlob, Status: notes.ItemStatusUnknown, Title: requested}
	b, ok, err := x.GetBlob(ctx, blobID)
	if err != nil {
		return notes.ItemInfo{}, err
	}
	if ok && len(b.Paths) > 0 {
		return notes.ItemInfo{
			ID: requested, Kind: notes.ItemKindBlob, Status: notes.ItemStatusOK,
			Title: path.Base(b.Paths[0]), Path: b.Paths[0], UpdatedAt: time.Unix(b.UpdatedAt, 0).UTC(),
		}, nil
	}
	return x.deletedItem(ctx, unknown, blobID)
}

func (x *Indexer) deletedItem(ctx context.Context, unknown notes.ItemInfo, id string) (notes.ItemInfo, error) {
	ts, ok, err := x.GetTombstone(ctx, id)
	if err != nil {
		return notes.ItemInfo{}, err
	}
	if !ok {
		return unknown, nil
	}
	return notes.ItemInfo{
		ID: unknown.ID, Kind: unknown.Kind, Status: notes.ItemStatusDeleted,
		Title: ts.LastTitle, Path: ts.LastPath, UpdatedAt: time.Unix(ts.DeletedAt, 0).UTC(), ReplacedBy: ts.ReplacedBy,
	}, nil
}

// excerpt is the first stretch of body text, collapsed to one line, with
// heading markers dropped so a note's title reads as prose.
func excerpt(body string) string {
	s := strings.Join(strings.Fields(headingMarkerRE.ReplaceAllString(body, "")), " ")
	if utf8.RuneCountInString(s) <= excerptRunes {
		return s
	}
	r := []rune(s)
	return string(r[:excerptRunes]) + "…"
}

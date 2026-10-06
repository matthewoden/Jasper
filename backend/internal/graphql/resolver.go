package graphql

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/matthewoden/jasper/backend/internal/graphql/model"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Resolver carries what the subgraph reads from. Blobs is nil when there is
// no index yet.
type Resolver struct {
	Notes  *notes.Service
	Index  notes.Index
	Blobs  ItemsIndex
	Events *Events
	Log    *slog.Logger
}

// ItemsIndex is what the subgraph reads about attachments and a note's
// outgoing references, which notes.Index does not carry.
type ItemsIndex interface {
	GetBlob(ctx context.Context, id string) (index.Blob, bool, error)
	RefsBySource(ctx context.Context, sourceID notes.ID) ([]index.NoteRef, error)
	SearchBlobNames(ctx context.Context, q string, limit int) ([]index.BlobHit, error)
}

// canonicalRef is the ref an item answers to: a bare note or blob id is
// given its jasper: prefix, a title ref resolves to the note it names, and
// anything else is returned as written.
func (r *Resolver) canonicalRef(id string) string {
	ref, err := notes.ParseItemRef(id)
	if err != nil {
		return strings.TrimSpace(id)
	}
	if ref.Native() && ref.Kind == notes.RefKindTitle {
		if noteID, ok := r.Notes.ResolveTitle(ref.ID, ""); ok {
			return notes.RefForNote(noteID)
		}
	}
	return ref.String()
}

// resolveItem answers jasperItem(id) for any ref, with a nil Item for a native id
// that is neither known nor remembered.
func (r *Resolver) resolveItem(ctx context.Context, id string) (model.Item, error) {
	ref := r.canonicalRef(id)
	info, err := r.Notes.LookupItem(ctx, ref)
	if err != nil {
		return nil, err
	}
	info.ID = ref
	return r.toItem(ctx, info)
}

func (r *Resolver) toItem(ctx context.Context, info notes.ItemInfo) (model.Item, error) {
	switch info.Kind {
	case notes.ItemKindForeign:
		return &model.ForeignRef{
			ID: info.ID, Kind: model.ItemKindForeign, Status: model.ItemStatusUnknown,
			Title: info.ID, Namespace: info.ID[:strings.Index(info.ID, ":")],
		}, nil
	case notes.ItemKindBlob:
		return r.toBlob(ctx, info)
	default:
		if info.Status == notes.ItemStatusUnknown {
			return nil, nil
		}
		return &model.Note{
			ID: info.ID, Kind: model.ItemKindNote, Status: model.ItemStatus(info.Status),
			Title: info.Title, UpdatedAt: optTime(info.UpdatedAt),
			Path: optString(info.Path), Excerpt: optString(info.Excerpt),
		}, nil
	}
}

func (r *Resolver) toBlob(ctx context.Context, info notes.ItemInfo) (model.Item, error) {
	if info.Status == notes.ItemStatusUnknown {
		return nil, nil
	}
	b := &model.Blob{
		ID: info.ID, Kind: model.ItemKindBlob, Status: model.ItemStatus(info.Status),
		Title: info.Title, UpdatedAt: optTime(info.UpdatedAt), Paths: []string{},
		ReplacedBy: optString(info.ReplacedBy),
	}
	if ref, err := notes.ParseItemRef(info.ID); err == nil && info.Status == notes.ItemStatusOK && r.Blobs != nil {
		blob, ok, err := r.Blobs.GetBlob(ctx, ref.ID)
		if err != nil {
			return nil, err
		}
		if ok {
			b.Paths = blob.Paths
			b.Mime = optString(blob.Mime)
			size := int(blob.Size)
			b.Size = &size
		}
	}
	return b, nil
}

// noteID is the ULID behind a Note's universal ref.
func noteID(ref string) (notes.ID, bool) {
	parsed, err := notes.ParseItemRef(ref)
	if err != nil || parsed.Kind != notes.RefKindNote {
		return "", false
	}
	id, err := notes.ParseID(parsed.ID)
	return id, err == nil
}

func optString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func optTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	u := t.UTC()
	return &u
}

func (r *Resolver) backlinksFor(ctx context.Context, ref string) ([]model.Backlink, error) {
	out := []model.Backlink{}
	if r.Index == nil {
		return out, nil
	}
	rows, err := r.Index.RefBacklinks(ctx, ref)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		out = append(out, model.Backlink{
			Source: &model.Note{
				ID: notes.RefForNote(row.SourceID), Kind: model.ItemKindNote, Status: model.ItemStatusOk,
				Title: row.SourceTitle, Path: optString(row.SourcePath),
			},
			Display: row.Display,
			Embed:   row.Embed,
		})
	}
	return out, nil
}

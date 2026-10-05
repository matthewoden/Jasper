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

// Resolver carries what the subgraph reads from. Blobs is the concrete
// indexer, which alone knows attachments; nil when there is no index yet.
type Resolver struct {
	Notes  *notes.Service
	Index  notes.Index
	Blobs  *index.Indexer
	Events *Events
	Log    *slog.Logger
}

// canonicalRef is the ref an item answers to: a bare note or blob id is
// given its jasper: prefix, a title ref resolves to the note it names, and
// anything else is returned as written.
func (r *Resolver) canonicalRef(id string) string {
	id = strings.TrimSpace(id)
	switch {
	case strings.HasPrefix(id, "jasper:title/"):
		if noteID, ok := r.Notes.ResolveTitle(strings.TrimPrefix(id, "jasper:title/"), ""); ok {
			return notes.RefForNote(noteID)
		}
		return id
	case strings.HasPrefix(id, "sha256-"):
		return notes.RefForBlob(id)
	case !strings.Contains(id, ":"):
		if parsed, err := notes.ParseID(id); err == nil {
			return notes.RefForNote(parsed)
		}
	}
	return id
}

// resolveItem answers item(id) for any ref, with a nil Item for a native id
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
	if info.Status == notes.ItemStatusOK && r.Blobs != nil {
		blob, ok, err := r.Blobs.GetBlob(ctx, strings.TrimPrefix(info.ID, "jasper:blob/"))
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
	id, err := notes.ParseID(strings.TrimPrefix(ref, "jasper:note/"))
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

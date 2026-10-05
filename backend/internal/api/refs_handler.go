package api

import (
	"context"
	"errors"
	"strings"

	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

const itemsBatchMax = 200

// GetRefBacklinks implements GET /api/v1/refs/backlinks?id=<ref>.
func (s *Server) GetRefBacklinks(
	ctx context.Context,
	req GetRefBacklinksRequestObject,
) (GetRefBacklinksResponseObject, error) {
	rows, err := s.index.RefBacklinks(ctx, strings.TrimSpace(req.Params.Id))
	if err != nil {
		s.log.Error("GetRefBacklinks: index error", "ref", req.Params.Id, "err", err)
		return nil, errors.New("could not load backlinks")
	}
	out := make([]RefBacklinkRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, RefBacklinkRow{
			SourceId:    r.SourceID.String(),
			SourceTitle: r.SourceTitle,
			SourcePath:  r.SourcePath,
			Display:     r.Display,
			Embed:       r.Embed,
		})
	}
	return GetRefBacklinks200JSONResponse{Backlinks: out}, nil
}

// PostItemsBatch implements POST /api/v1/items/batch.
func (s *Server) PostItemsBatch(
	ctx context.Context,
	req PostItemsBatchRequestObject,
) (PostItemsBatchResponseObject, error) {
	if req.Body == nil {
		return PostItemsBatch400JSONResponse(newError("invalid_request", "request body required")), nil
	}
	if len(req.Body.Ids) > itemsBatchMax {
		return PostItemsBatch400JSONResponse(newError("invalid_request", "at most 200 ids per request")), nil
	}
	items := make([]Item, 0, len(req.Body.Ids))
	for _, raw := range req.Body.Ids {
		info, err := s.lookupItem(ctx, strings.TrimSpace(raw))
		if err != nil {
			s.log.Error("PostItemsBatch: lookup failed", "id", raw, "err", err)
			return nil, errors.New("could not resolve items")
		}
		items = append(items, toWireItem(info))
	}
	return PostItemsBatch200JSONResponse{Items: items}, nil
}

// lookupItem routes an id by shape: a title ref resolves through the
// registry first, a native id through the index, and any other well-formed
// ref is foreign and comes back as a raw stub.
func (s *Server) lookupItem(ctx context.Context, id string) (notes.ItemInfo, error) {
	switch {
	case strings.HasPrefix(id, "jasper:title/"):
		title := strings.TrimPrefix(id, "jasper:title/")
		if noteID, ok := s.notes.ResolveTitle(title, ""); ok {
			info, err := s.index.LookupItem(ctx, noteID.String())
			info.ID = id
			return info, err
		}
		return notes.ItemInfo{ID: id, Kind: notes.ItemKindNote, Status: notes.ItemStatusUnknown, Title: title}, nil
	case strings.HasPrefix(id, "jasper:") || strings.HasPrefix(id, "sha256-") || !markdown.IsRefTarget(id):
		return s.index.LookupItem(ctx, id)
	default:
		return notes.ItemInfo{ID: id, Kind: notes.ItemKindForeign, Status: notes.ItemStatusUnknown, Title: id}, nil
	}
}

func toWireItem(info notes.ItemInfo) Item {
	item := Item{
		Id:     info.ID,
		Kind:   ItemKind(info.Kind),
		Status: ItemStatus(info.Status),
		Title:  info.Title,
	}
	if info.Path != "" {
		item.Path = &info.Path
	}
	if !info.UpdatedAt.IsZero() {
		t := info.UpdatedAt
		item.UpdatedAt = &t
	}
	if info.Excerpt != "" {
		item.Excerpt = &info.Excerpt
	}
	if info.ReplacedBy != "" {
		item.ReplacedBy = &info.ReplacedBy
	}
	return item
}

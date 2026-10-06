package api

import (
	"context"
	"errors"
	"fmt"
	"strings"

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
		return PostItemsBatch400JSONResponse(newError("invalid_request", fmt.Sprintf("at most %d ids per request", itemsBatchMax))), nil
	}
	items := make([]Item, 0, len(req.Body.Ids))
	for _, raw := range req.Body.Ids {
		info, err := s.notes.LookupItem(ctx, strings.TrimSpace(raw))
		if err != nil {
			s.log.Error("PostItemsBatch: lookup failed", "id", raw, "err", err)
			return nil, errors.New("could not resolve items")
		}
		items = append(items, toWireItem(info))
	}
	return PostItemsBatch200JSONResponse{Items: items}, nil
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

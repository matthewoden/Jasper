package api

import (
	"context"
	"errors"

	openapi_types "github.com/oapi-codegen/runtime/types"
)

// GetNoteBacklinks implements GET /api/v1/notes/{id}/backlinks.
//
// Excerpt HTML is built here but NOT sanitized — the client must pass it
// through sanitize.ts before rendering.
//
//nolint:revive // generated interface name
func (s *Server) GetNoteBacklinks(
	ctx context.Context,
	req GetNoteBacklinksRequestObject,
) (GetNoteBacklinksResponseObject, error) {
	id := req.Id

	if s.index == nil {
		return GetNoteBacklinks200JSONResponse{Backlinks: []BacklinkRow{}}, nil
	}

	summaries, err := s.index.List(ctx)
	if err != nil {
		s.log.Error("GetNoteBacklinks: list failed", "id", openapi_types.UUID(id).String(), "err", err)
		return nil, errors.New("could not check note existence")
	}
	found := false
	for _, sm := range summaries {
		if sm.ID == id {
			found = true
			break
		}
	}
	if !found {
		return GetNoteBacklinks404JSONResponse(newError("not_found", "note not found")), nil
	}

	rows, err := s.index.GetBacklinks(ctx, id)
	if err != nil {
		s.log.Error("GetNoteBacklinks: index error", "id", openapi_types.UUID(id).String(), "err", err)
		return nil, errors.New("could not load backlinks")
	}

	out := make([]BacklinkRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, BacklinkRow{
			SourceId:    openapi_types.UUID(r.SourceID),
			SourceTitle: r.SourceTitle,
			SourcePath:  r.SourcePath,
			Excerpts:    r.Excerpts,
		})
	}
	return GetNoteBacklinks200JSONResponse{Backlinks: out}, nil
}

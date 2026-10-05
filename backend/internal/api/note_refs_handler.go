package api

import (
	"context"
	"errors"

	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// GetNoteRefs implements GET /api/v1/notes/{id}/refs.
func (s *Server) GetNoteRefs(
	ctx context.Context,
	req GetNoteRefsRequestObject,
) (GetNoteRefsResponseObject, error) {
	id := notes.ID(req.Id)
	if _, ok := s.notes.LookupSummary(id); !ok {
		return GetNoteRefs404JSONResponse(newError("not_found", "note not found")), nil
	}
	idx, ok := s.index.(*index.Indexer)
	if !ok || idx == nil {
		return GetNoteRefs200JSONResponse{Refs: []NoteRef{}}, nil
	}
	rows, err := idx.RefsBySource(ctx, id)
	if err != nil {
		s.log.Error("GetNoteRefs: index error", "id", req.Id, "err", err)
		return nil, errors.New("could not load references")
	}
	out := make([]NoteRef, 0, len(rows))
	for _, r := range rows {
		out = append(out, NoteRef{TargetRef: r.TargetRef, Display: r.Display, Embed: r.Embed, Position: r.Position})
	}
	return GetNoteRefs200JSONResponse{Refs: out}, nil
}

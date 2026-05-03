package api

import (
	"context"
	"errors"

	openapi_types "github.com/oapi-codegen/runtime/types"
)

// GetNotes implements GET /api/v1/notes — returns the indexed
// notes-list metadata. DATA-01: filesystem is the source of truth, the
// index is a derived projection; this endpoint reads only the index.
//
// Phase 1 compatibility: callers that build the Server via 2-arg
// NewServer pass a nil index → the handler returns an empty list
// (NOT 503) so the frontend's MigrationBanner / file-tree work even
// when the indexer is not yet wired.
//
// Order: the index already returns rows ordered by path ASC; the
// handler does NOT re-sort. The wire shape is api.NoteList = {notes:
// NoteSummary[]} with no pagination in Phase 2 (Phase 6 introduces
// pagination if and when total counts demand it).
//
// Threat T-02-04a-02: NoteSummary is a strict subset of the indexer's
// NoteRecord — Checksum and UpdatedAtUnix are intentionally absent
// from the wire format.
//
//nolint:revive // generated interface name
func (s *Server) GetNotes(
	ctx context.Context,
	_ GetNotesRequestObject,
) (GetNotesResponseObject, error) {
	if s.index == nil {
		// Phase 1 compatibility: return an empty list rather than 503.
		// The wire format is `{notes: []}` — never null per
		// TestGetNotes_Empty_ReturnsEmptyArray.
		return GetNotes200JSONResponse{Notes: []NoteSummary{}}, nil
	}
	summaries, err := s.index.List(ctx)
	if err != nil {
		s.log.Error("GetNotes: list failed", "err", err)
		// Voice rule (T-02-04b-02): never leak the wrapped chain to the
		// wire. Strict-server returns a generic 500 from a bare error.
		return nil, errors.New("could not load notes")
	}
	out := GetNotes200JSONResponse{Notes: make([]NoteSummary, 0, len(summaries))}
	for _, sm := range summaries {
		out.Notes = append(out.Notes, NoteSummary{
			Id:        openapi_types.UUID(sm.ID),
			Path:      sm.Path,
			Title:     sm.Title,
			UpdatedAt: sm.UpdatedAt,
		})
	}
	return out, nil
}

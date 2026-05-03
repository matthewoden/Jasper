package api

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
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

// PostNotes implements POST /api/v1/notes (TREE-03 — note creation).
//
// Thin shim per Plan 03-04: validate body presence → call
// notes.Service.Create → translate response. All business logic lives
// in the service layer; the handler only fan-outs the locked error
// table.
//
//nolint:revive // generated interface name
func (s *Server) PostNotes(
	ctx context.Context,
	req PostNotesRequestObject,
) (PostNotesResponseObject, error) {
	if req.Body == nil {
		return PostNotes400JSONResponse(newError("invalid_request", "request body required")), nil
	}
	summary, err := s.notes.Create(ctx, req.Body.ParentPath, req.Body.Title)
	if err != nil {
		s.log.Error("PostNotes: domain error",
			"parent", req.Body.ParentPath,
			"title", req.Body.Title,
			"err", err,
		)
		if code, msg, ok := mapServiceErrorToWire(err); ok {
			switch code {
			case "case_collision":
				return PostNotes409JSONResponse(newError(code, msg)), nil
			case "parent_not_found", "invalid_path", "invalid_request":
				return PostNotes400JSONResponse(newError(code, msg)), nil
			}
		}
		// Bare error → strict-server emits 500 with a generic message.
		return nil, errors.New("could not create note")
	}
	return PostNotes201JSONResponse{
		Id:        openapi_types.UUID(summary.ID),
		Path:      summary.Path,
		Title:     summary.Title,
		UpdatedAt: summary.UpdatedAt,
	}, nil
}

// DeleteNoteById implements DELETE /api/v1/notes/{id} (TREE-06).
//
//nolint:revive // generated interface name
func (s *Server) DeleteNoteById(
	ctx context.Context,
	req DeleteNoteByIdRequestObject,
) (DeleteNoteByIdResponseObject, error) {
	if err := s.notes.Delete(ctx, uuid.UUID(req.Id)); err != nil {
		s.log.Error("DeleteNoteById: domain error",
			"id", uuid.UUID(req.Id).String(),
			"err", err,
		)
		if code, msg, ok := mapServiceErrorToWire(err); ok {
			if code == "not_found" {
				return DeleteNoteById404JSONResponse(newError(code, msg)), nil
			}
		}
		// Any other error: 500 via bare error.
		return nil, errors.New("could not delete note")
	}
	return DeleteNoteById204Response{}, nil
}

// PostNoteMove implements POST /api/v1/notes/{id}/move (TREE-05, TREE-07).
//
//nolint:revive // generated interface name
func (s *Server) PostNoteMove(
	ctx context.Context,
	req PostNoteMoveRequestObject,
) (PostNoteMoveResponseObject, error) {
	if req.Body == nil {
		return PostNoteMove400JSONResponse(newError("invalid_request", "request body required")), nil
	}
	summary, err := s.notes.Move(ctx, uuid.UUID(req.Id), req.Body.NewPath)
	if err != nil {
		s.log.Error("PostNoteMove: domain error",
			"id", uuid.UUID(req.Id).String(),
			"new_path", req.Body.NewPath,
			"err", err,
		)
		if code, msg, ok := mapServiceErrorToWire(err); ok {
			switch code {
			case "not_found":
				return PostNoteMove404JSONResponse(newError(code, msg)), nil
			case "case_collision":
				return PostNoteMove409JSONResponse(newError(code, msg)), nil
			case "parent_not_found", "invalid_path", "invalid_request":
				return PostNoteMove400JSONResponse(newError(code, msg)), nil
			}
		}
		return nil, errors.New("could not move note")
	}
	// Service.Move returns NoteSummary with UpdatedAt synthesized from
	// the index mtime. Wire that through unchanged.
	updatedAt := summary.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = time.Now().UTC()
	}
	return PostNoteMove200JSONResponse{
		Id:        openapi_types.UUID(summary.ID),
		Path:      summary.Path,
		Title:     summary.Title,
		UpdatedAt: updatedAt,
	}, nil
}

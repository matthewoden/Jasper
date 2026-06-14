package api

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// GetNotes implements GET /api/v1/notes — returns the indexed notes-list
// metadata. The filesystem is the source of truth; the index is a derived
// projection. Nil index returns an empty list (NOT 503) so the frontend
// remains functional when the indexer is not wired.
//
// Rows are returned in the index's natural order (path ASC); the handler does
// not re-sort. NoteSummary intentionally omits Checksum and UpdatedAtUnix.
//
//nolint:revive // generated interface name
func (s *Server) GetNotes(
	ctx context.Context,
	_ GetNotesRequestObject,
) (GetNotesResponseObject, error) {
	if s.index == nil {
		return GetNotes200JSONResponse{Notes: []NoteSummary{}}, nil
	}
	summaries, err := s.index.List(ctx)
	if err != nil {
		s.log.Error("GetNotes: list failed", "err", err)

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

// PostNotes implements POST /api/v1/notes (note creation). Thin shim:
// validate body → call notes.Service.Create → translate response.
//
//nolint:revive // generated interface name
func (s *Server) PostNotes(
	ctx context.Context,
	req PostNotesRequestObject,
) (PostNotesResponseObject, error) {
	defer s.trackWrite()()
	if req.Body == nil {
		return PostNotes400JSONResponse(newError("invalid_request", "request body required")), nil
	}
	summary, err := s.notes.Create(ctx, req.Body.ParentPath, req.Body.Title)
	if err != nil {
		s.log.Error(
			"PostNotes: domain error",
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

		return nil, errors.New("could not create note")
	}
	return PostNotes201JSONResponse{
		Id:        openapi_types.UUID(summary.ID),
		Path:      summary.Path,
		Title:     summary.Title,
		UpdatedAt: summary.UpdatedAt,
	}, nil
}

// DeleteNoteById implements DELETE /api/v1/notes/{id}.
//
//nolint:revive // generated interface name
func (s *Server) DeleteNoteById(
	ctx context.Context,
	req DeleteNoteByIdRequestObject,
) (DeleteNoteByIdResponseObject, error) {
	defer s.trackWrite()()
	if err := s.notes.Delete(ctx, uuid.UUID(req.Id)); err != nil {
		s.log.Error(
			"DeleteNoteById: domain error",
			"id", uuid.UUID(req.Id).String(),
			"err", err,
		)
		if code, msg, ok := mapServiceErrorToWire(err); ok {
			if code == "not_found" {
				return DeleteNoteById404JSONResponse(newError(code, msg)), nil
			}
		}

		return nil, errors.New("could not delete note")
	}
	return DeleteNoteById204Response{}, nil
}

// PostNoteMove implements POST /api/v1/notes/{id}/move.
//
// After a successful move, if the note's title changed, the handler invokes
// Service.RenameRewriteWikilinks to rewrite all inbound [[OldTitle]] refs
// vault-wide. On any rewrite failure the move is rolled back (all-or-nothing)
// and a links:rewritten WS event with error:true is broadcast so the UI can
// surface a rename-failed banner.
//
//nolint:revive // generated interface name
func (s *Server) PostNoteMove(
	ctx context.Context,
	req PostNoteMoveRequestObject,
) (PostNoteMoveResponseObject, error) {
	defer s.trackWrite()()
	if req.Body == nil {
		return PostNoteMove400JSONResponse(newError("invalid_request", "request body required")), nil
	}

	id := uuid.UUID(req.Id)

	var oldTitle string
	oldSummary, _ := s.notes.LookupSummary(id)
	oldPath := oldSummary.Path
	if preNote, getErr := s.notes.Get(ctx, id); getErr == nil {
		oldTitle = markdown.ExtractTitle([]byte(preNote.Content), preNote.Path)
	} else {
		oldTitle = s.notes.LookupTitle(id)
	}

	summary, err := s.notes.Move(ctx, id, req.Body.NewPath)
	if err != nil {
		s.log.Error(
			"PostNoteMove: domain error",
			"id", id.String(),
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

	newTitle := summary.Title

	if oldTitle != "" && newTitle != "" && !strings.EqualFold(oldTitle, newTitle) {
		touched, rwErr := s.notes.RenameRewriteWikilinks(ctx, oldTitle, newTitle)
		if rwErr != nil {
			if oldPath != "" {
				if _, rbErr := s.notes.Move(ctx, id, oldPath); rbErr != nil {
					s.log.Error(
						"PostNoteMove: rename-rewrite rollback failed",
						"id", id.String(),
						"rewrite_err", rwErr,
						"rollback_err", rbErr,
					)
				}
			}

			if s.broadcaster != nil {
				ids := make([]string, len(touched))
				for i, tid := range touched {
					ids[i] = tid.String()
				}
				s.broadcaster.Broadcast(notes.EventLinksRewritten, map[string]any{
					"old_title":        oldTitle,
					"new_title":        newTitle,
					"touched_note_ids": ids,
					"error":            true,
				}, notes.SessionIDFromContext(ctx))
			}

			rolledBack, _ := s.notes.LookupSummary(id)
			rolledAt := time.Now().UTC()
			return PostNoteMove200JSONResponse{
				Id:        openapi_types.UUID(rolledBack.ID),
				Path:      rolledBack.Path,
				Title:     rolledBack.Title,
				UpdatedAt: rolledAt,
			}, nil
		}

		_ = touched
	}

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

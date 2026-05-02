package api

import (
	"context"
	"errors"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Server bundles dependencies and implements api.StrictServerInterface.
// Plan 04's app.New wires the concrete *notes.Service in.
type Server struct {
	notes *notes.Service
}

// NewServer constructs a Server bound to the given notes domain service.
func NewServer(notesSvc *notes.Service) *Server {
	return &Server{notes: notesSvc}
}

// Compile-time assertion: Server satisfies StrictServerInterface.
// This is the Pitfall 11 mitigation — adding a method to the OpenAPI spec
// without implementing it here breaks the build.
var _ StrictServerInterface = (*Server)(nil)

// GetNoteById implements GET /api/v1/notes/{id}.
//
// Per ARCHITECTURE.md §13 anti-pattern 1, the handler is a thin shim:
// translate the request, call the domain service, translate the response.
// All business logic lives in notes.Service.
//
// Method name `Id` (not `ID`) is forced by oapi-codegen, which derives the
// StrictServerInterface method names from the OpenAPI operationId.
//
//nolint:revive // generated interface name
func (s *Server) GetNoteById(
	ctx context.Context,
	request GetNoteByIdRequestObject,
) (GetNoteByIdResponseObject, error) {
	note, err := s.notes.Get(ctx, uuid.UUID(request.Id))
	if err != nil {
		if errors.Is(err, notes.ErrNotFound) {
			return GetNoteById404JSONResponse(newError("not_found", err.Error())), nil
		}
		// Any other error is a 500 — return it to the strict-server
		// middleware which calls ResponseErrorHandlerFunc (default:
		// http.StatusInternalServerError with the error message).
		return nil, err
	}
	return GetNoteById200JSONResponse{
		Id:        openapi_types.UUID(note.ID),
		Path:      note.Path,
		Content:   note.Content,
		UpdatedAt: note.UpdatedAt,
	}, nil
}

// PutNoteById implements PUT /api/v1/notes/{id}.
//
//nolint:revive // generated interface name (see GetNoteById)
func (s *Server) PutNoteById(
	ctx context.Context,
	request PutNoteByIdRequestObject,
) (PutNoteByIdResponseObject, error) {
	if request.Body == nil {
		return PutNoteById400JSONResponse(newError("invalid_request", "request body required")), nil
	}
	note, err := s.notes.Update(ctx, uuid.UUID(request.Id), request.Body.Content)
	if err != nil {
		if errors.Is(err, notes.ErrNotFound) {
			return PutNoteById404JSONResponse(newError("not_found", err.Error())), nil
		}
		// Any other error from the domain layer (Canonicalize escape,
		// AtomicWrite IO, Stat, etc.) maps to a 500 with code
		// "write_failed" — same shape as the openapi.yaml Error schema.
		return PutNoteById500JSONResponse(newError("write_failed", err.Error())), nil
	}
	return PutNoteById200JSONResponse{
		Id:        openapi_types.UUID(note.ID),
		Path:      note.Path,
		UpdatedAt: note.UpdatedAt,
	}, nil
}

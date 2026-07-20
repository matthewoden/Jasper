package api

import (
	"context"
	"errors"

	"github.com/matthewoden/jasper/backend/internal/workspace"
)

// GetVaultWorkspace implements GET /api/v1/vault/workspace.
//
// Reads the whole workspace document directly via workspace.Load (not
// through s.workspace, which only exposes mutation methods), mirroring
// GetBookmarks' read-path (bookmarks_handler.go).
//
//nolint:revive // generated interface name
func (s *Server) GetVaultWorkspace(
	ctx context.Context,
	_ GetVaultWorkspaceRequestObject,
) (GetVaultWorkspaceResponseObject, error) {
	doc, err := workspace.Load(s.dataDir, s.log)
	if err != nil {
		s.log.Error("GetVaultWorkspace: domain error", "err", err)
		return nil, errors.New("could not load workspace preferences")
	}
	return GetVaultWorkspace200JSONResponse(toWireWorkspace(doc)), nil
}

// PutVaultWorkspace implements PUT /api/v1/vault/workspace.
//
// Persists whichever of notesSort/searchSort are present in the body — a
// nil field is skipped (left untouched by the corresponding Service
// setter). Rejects an out-of-enum value with 400 before either setter
// touches disk.
//
//nolint:revive // generated interface name
func (s *Server) PutVaultWorkspace(
	ctx context.Context,
	req PutVaultWorkspaceRequestObject,
) (PutVaultWorkspaceResponseObject, error) {
	defer s.trackWrite()()
	if req.Body == nil {
		return PutVaultWorkspace400JSONResponse(newError("invalid_request", "request body required")), nil
	}

	var doc workspace.Workspace
	if req.Body.NotesSort != nil {
		updated, err := s.workspace.SetNotesSort(ctx, string(*req.Body.NotesSort))
		if err != nil {
			s.log.Error("PutVaultWorkspace: domain error", "field", "notesSort", "err", err)
			if errors.Is(err, workspace.ErrInvalidSort) {
				return PutVaultWorkspace400JSONResponse(newError("invalid_request", "invalid notesSort value")), nil
			}
			return nil, errors.New("could not update workspace preferences")
		}
		doc = updated
	}
	if req.Body.SearchSort != nil {
		updated, err := s.workspace.SetSearchSort(ctx, string(*req.Body.SearchSort))
		if err != nil {
			s.log.Error("PutVaultWorkspace: domain error", "field", "searchSort", "err", err)
			if errors.Is(err, workspace.ErrInvalidSort) {
				return PutVaultWorkspace400JSONResponse(newError("invalid_request", "invalid searchSort value")), nil
			}
			return nil, errors.New("could not update workspace preferences")
		}
		doc = updated
	}

	if req.Body.NotesSort == nil && req.Body.SearchSort == nil {
		loaded, err := workspace.Load(s.dataDir, s.log)
		if err != nil {
			s.log.Error("PutVaultWorkspace: domain error", "err", err)
			return nil, errors.New("could not load workspace preferences")
		}
		doc = loaded
	}

	return PutVaultWorkspace200JSONResponse(toWireWorkspace(doc)), nil
}

func toWireWorkspace(doc workspace.Workspace) Workspace {
	wire := Workspace{}
	if doc.NotesSort != "" {
		v := WorkspaceNotesSort(doc.NotesSort)
		wire.NotesSort = &v
	}
	if doc.SearchSort != "" {
		v := WorkspaceSearchSort(doc.SearchSort)
		wire.SearchSort = &v
	}
	return wire
}

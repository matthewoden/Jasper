package api

import (
	"context"
	"errors"
	"path"
	"strings"
)

// PostFolders implements POST /api/v1/folders (folder creation).
//
// Validates body presence → calls notes.Service.CreateFolder → translates
// response. The wire response is a FolderNode with Children explicitly
// populated as an empty (non-nil) slice.
//
//nolint:revive // generated interface name
func (s *Server) PostFolders(
	ctx context.Context,
	req PostFoldersRequestObject,
) (PostFoldersResponseObject, error) {
	defer s.trackWrite()()
	if req.Body == nil {
		return PostFolders400JSONResponse(newError("invalid_request", "request body required")), nil
	}
	folderPath, err := s.notes.CreateFolder(ctx, req.Body.ParentPath, req.Body.Name)
	if err != nil {
		s.log.Error(
			"PostFolders: domain error",
			"parent", req.Body.ParentPath,
			"name", req.Body.Name,
			"err", err,
		)
		if code, msg, ok := mapServiceErrorToWire(err); ok {
			switch code {
			case "case_collision":
				return PostFolders409JSONResponse(newError(code, msg)), nil
			case "parent_not_found", "invalid_path", "invalid_request":
				return PostFolders400JSONResponse(newError(code, msg)), nil
			}
		}
		return nil, errors.New("could not create folder")
	}
	emptyChildren := []TreeNode{}
	return PostFolders201JSONResponse{
		Kind:     FolderNodeKind("folder"),
		Path:     folderPath,
		Name:     folderBasename(folderPath),
		Children: &emptyChildren,
	}, nil
}

// DeleteFolder implements DELETE /api/v1/folders.
//
// Query parameters:
//   - path (required) — canonical relative path of the folder to delete
//   - recursive (optional, default false) — when false, refuses non-empty
//     folders with 409 folder_not_empty; when true, removes the entire subtree.
//
//nolint:revive // generated interface name
func (s *Server) DeleteFolder(
	ctx context.Context,
	req DeleteFolderRequestObject,
) (DeleteFolderResponseObject, error) {
	defer s.trackWrite()()
	recursive := false
	if req.Params.Recursive != nil {
		recursive = *req.Params.Recursive
	}
	if err := s.notes.DeleteFolder(ctx, req.Params.Path, recursive); err != nil {
		s.log.Error(
			"DeleteFolder: domain error",
			"path", req.Params.Path,
			"recursive", recursive,
			"err", err,
		)
		if code, msg, ok := mapServiceErrorToWire(err); ok {
			switch code {
			case "not_found":
				return DeleteFolder404JSONResponse(newError(code, msg)), nil
			case "folder_not_empty":
				return DeleteFolder409JSONResponse(newError(code, msg)), nil
			case "invalid_path", "invalid_request", "parent_not_found":
				return DeleteFolder400JSONResponse(newError(code, msg)), nil
			}
		}
		return nil, errors.New("could not delete folder")
	}
	return DeleteFolder204Response{}, nil
}

// PostFolderMove implements POST /api/v1/folders/move.
//
//nolint:revive // generated interface name
func (s *Server) PostFolderMove(
	ctx context.Context,
	req PostFolderMoveRequestObject,
) (PostFolderMoveResponseObject, error) {
	defer s.trackWrite()()
	if req.Body == nil {
		return PostFolderMove400JSONResponse(newError("invalid_request", "request body required")), nil
	}
	newCanonPath, err := s.notes.MoveFolder(ctx, req.Body.OldPath, req.Body.NewPath)
	if err != nil {
		s.log.Error(
			"PostFolderMove: domain error",
			"old_path", req.Body.OldPath,
			"new_path", req.Body.NewPath,
			"err", err,
		)
		if code, msg, ok := mapServiceErrorToWire(err); ok {
			switch code {
			case "not_found":
				return PostFolderMove404JSONResponse(newError(code, msg)), nil
			case "case_collision":
				return PostFolderMove409JSONResponse(newError(code, msg)), nil
			case "cycle", "invalid_path", "invalid_request", "parent_not_found":
				return PostFolderMove400JSONResponse(newError(code, msg)), nil
			}
		}
		return nil, errors.New("could not move folder")
	}
	emptyChildren := []TreeNode{}
	return PostFolderMove200JSONResponse{
		Kind:     FolderNodeKind("folder"),
		Path:     newCanonPath,
		Name:     folderBasename(newCanonPath),
		Children: &emptyChildren,
	}, nil
}

func folderBasename(p string) string {
	p = strings.Trim(p, "/")
	if p == "" {
		return ""
	}
	return path.Base(p)
}

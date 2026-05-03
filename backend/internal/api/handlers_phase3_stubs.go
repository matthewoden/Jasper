// PLAN-03-04 IMPL: this file is a temporary set of strict-server stubs
// so Plan 03-01's openapi.yaml extension keeps the build green. Plan 03-04
// implements every method below as a real handler and deletes this file
// (idempotent: missing-file is not an error).
package api

import (
	"context"
	"errors"
)

// errStubNotImplementedPhase3 is returned by every Phase 3 handler stub
// below. The strict-server runtime maps a bare error return to a 500
// (NOT a silent 200/204) — so any forgotten Plan 03-04 wiring surfaces
// immediately rather than masquerading as success (T-03-01-07).
var errStubNotImplementedPhase3 = errors.New("phase 3 handler not yet implemented")

// GetTree is the Plan 03-04 stub for GET /tree (TREE-01).
//
//nolint:revive // generated interface name
func (s *Server) GetTree(
	_ context.Context,
	_ GetTreeRequestObject,
) (GetTreeResponseObject, error) {
	return nil, errStubNotImplementedPhase3
}

// PostFolders is the Plan 03-04 stub for POST /folders (TREE-04).
//
//nolint:revive // generated interface name
func (s *Server) PostFolders(
	_ context.Context,
	_ PostFoldersRequestObject,
) (PostFoldersResponseObject, error) {
	return nil, errStubNotImplementedPhase3
}

// DeleteFolder is the Plan 03-04 stub for DELETE /folders (TREE-06).
//
//nolint:revive // generated interface name
func (s *Server) DeleteFolder(
	_ context.Context,
	_ DeleteFolderRequestObject,
) (DeleteFolderResponseObject, error) {
	return nil, errStubNotImplementedPhase3
}

// PostFolderMove is the Plan 03-04 stub for POST /folders/move
// (TREE-05, TREE-07).
//
//nolint:revive // generated interface name
func (s *Server) PostFolderMove(
	_ context.Context,
	_ PostFolderMoveRequestObject,
) (PostFolderMoveResponseObject, error) {
	return nil, errStubNotImplementedPhase3
}

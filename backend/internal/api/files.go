package api

// files.go — GET /api/v1/files?path=... (UAT-3 R7 / Plan 07-32a).
//
// RED-phase stub. Returns a hard-coded 404 so the StrictServerInterface is
// satisfied (codegen requires *Server to implement GetFile) but every
// TestGetFile_* test fails at runtime. The GREEN commit replaces this body
// with the 5-rule path-traversal pipeline mirrored from GetAttachment.

import (
	"context"
)

//nolint:revive // generated interface name
func (s *Server) GetFile(
	_ context.Context,
	_ GetFileRequestObject,
) (GetFileResponseObject, error) {
	return GetFile404JSONResponse(newError("not_implemented", "RED stub")), nil
}

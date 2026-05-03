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


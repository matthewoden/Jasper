package api

// handlers_stubs.go — TEMPORARY Phase 2 Wave 1 stubs.
//
// The compile-time assertion `var _ StrictServerInterface = (*Server)(nil)`
// in handlers.go requires every spec-declared route to have a method on
// *Server. Plan 02-02 extends openapi.yaml with three new routes; the
// real handlers land in Plans 02-03 and 02-04. These stubs keep the
// build green during Wave 1 by returning a hard 501-shaped error.
//
// *** REMOVE the rest of this file when Plan 02-04b lands. ***
//
// Removal ledger (so Plan 02-04b, the last stub-removing plan, can
// delete this file once both downstream plans land):
//   - Plan 02-03 OWNED: GetAdminStatus stub — REMOVED in Plan 02-03.
//   - Plan 02-04b OWNS: GetNotes stub, PostAdminReindex stub, and the
//     deletion of this entire file once the last stub is replaced.

import (
	"context"
	"errors"
)

var errStubNotImplemented = errors.New("stub: handler not yet implemented (Wave 1 placeholder)")

// PLAN-02-04 IMPL — replace this with the real GetNotes that reads from
// the notes index (DATA-09 derived metadata).
//
//nolint:revive // generated interface name
func (s *Server) GetNotes(ctx context.Context, req GetNotesRequestObject) (GetNotesResponseObject, error) {
	_ = ctx
	_ = req
	return nil, errStubNotImplemented
}

// PLAN-02-04 IMPL — replace with the real admin/reindex handler
// (full and incremental modes per DATA-10).
//
//nolint:revive // generated interface name
func (s *Server) PostAdminReindex(ctx context.Context, req PostAdminReindexRequestObject) (PostAdminReindexResponseObject, error) {
	_ = ctx
	_ = req
	return nil, errStubNotImplemented
}

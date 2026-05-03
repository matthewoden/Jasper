package api

// handlers_stubs.go — TEMPORARY Phase 2 Wave 1 stubs.
//
// The compile-time assertion `var _ StrictServerInterface = (*Server)(nil)`
// in handlers.go requires every spec-declared route to have a method on
// *Server. Plan 02-02 extends openapi.yaml with three new routes, but
// the handlers themselves land in Plans 02-03 and 02-04. These stubs
// keep the build green during Wave 1 by returning a hard 501-shaped
// error.
//
// *** REMOVE when Plans 02-03 and 02-04 land. ***
//
// Removal ledger (so Plan 02-04, the last stub-removing plan, can delete
// the now-empty file once both downstream plans land):
//   - Plan 02-03 owns: GetAdminStatus stub
//   - Plan 02-04 owns: GetNotes stub, PostAdminReindex stub, and the
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

// PLAN-02-03 IMPL — replace with the real admin/status handler that
// surfaces the migration runner state for the UX-03 banner.
//
//nolint:revive // generated interface name
func (s *Server) GetAdminStatus(ctx context.Context, req GetAdminStatusRequestObject) (GetAdminStatusResponseObject, error) {
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

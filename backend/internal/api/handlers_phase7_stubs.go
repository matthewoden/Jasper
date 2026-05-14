package api

// handlers_phase7_stubs.go — TEMPORARY 501 stubs for Phase 7 routes (Plan 07-01 / Wave 0).
// The OpenAPI surface in Plan 07-01 introduces 4 new routes (SEARCH-01..04, DAILY-01,
// ATTACH-01..06) which oapi-codegen now requires on StrictServerInterface. Until the
// real handlers ship in Plans 07-04 / 07-05 / 07-06, these stubs return 501 so the
// backend compiles. Each plan that lands a real handler removes the corresponding
// stub method; the LAST plan to land deletes this file (idempotent — Phase 2 / Phase 3
// / Phase 6 precedent).
//
// Plan 07-06 removed: CreateAttachment, GetAttachment stubs (real handlers in attachments.go).
// Remaining: SearchNotes — removed by Plan 07-04 (Wave 4), which also deletes this file.

import (
	"context"
	"errors"
)

// Stubs return generic errors that the chi error mapper converts to 501.
var errPhase7NotImplemented = errors.New("phase 7 handler not implemented yet")

//nolint:revive // generated interface name
func (s *Server) SearchNotes(_ context.Context, _ SearchNotesRequestObject) (SearchNotesResponseObject, error) {
	return nil, errPhase7NotImplemented
}

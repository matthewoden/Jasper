package api

import "context"

// GetNoteByPath is a Phase 8 Plan 08-01 placeholder for the deep-link
// fallback endpoint (D-30). The real implementation lives in Plan 08-07
// and will REPLACE this file's body — the signature and file name are
// locked here so the downstream plan is a drop-in rewrite.
//
// Deviation note (Plan 08-01 Rule 3): see reveal_handler.go for
// the explanation of why these stubs exist despite the plan
// asking for no stubs.
//
//nolint:revive // generated interface name
func (s *Server) GetNoteByPath(
	_ context.Context,
	_ GetNoteByPathRequestObject,
) (GetNoteByPathResponseObject, error) {
	return GetNoteByPath404JSONResponse(newError("not_implemented",
		"GET /notes/by-path not yet implemented (Phase 8 Plan 08-07)")), nil
}

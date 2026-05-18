package api

import "context"

// Phase 8 Plan 08-01 placeholders for the /setup surface
// (INSTALL-07, D-04, D-08, D-10). The real implementation lives
// in Plan 08-02 and will REPLACE this file's bodies — the
// signatures and file name are locked here so the downstream plan
// is a drop-in rewrite.
//
// Deviation note (Plan 08-01 Rule 3): see reveal_handler.go for
// the explanation of why these stubs exist despite the plan
// asking for no stubs.

//nolint:revive // generated interface name
func (s *Server) GetSetupStatus(
	_ context.Context,
	_ GetSetupStatusRequestObject,
) (GetSetupStatusResponseObject, error) {
	// Returns first_run=false so existing app-shell mounts (which
	// have a resolved dataDir already) are not redirected to a
	// non-existent /setup route. Plan 08-02 implements the real
	// first-run detection (cfg.Server.DataDir empty / not in config).
	return GetSetupStatus200JSONResponse{FirstRun: false}, nil
}

//nolint:revive // generated interface name
func (s *Server) PostSetupValidateDataDir(
	_ context.Context,
	_ PostSetupValidateDataDirRequestObject,
) (PostSetupValidateDataDirResponseObject, error) {
	// Conservatively reports "not implemented" via the structured
	// envelope — wizard cannot ship before 08-02 anyway.
	code := ParentMissing
	msg := "setup validation not yet implemented (Phase 8 Plan 08-02)"
	return PostSetupValidateDataDir200JSONResponse{
		Valid:   false,
		Code:    &code,
		Message: &msg,
	}, nil
}

//nolint:revive // generated interface name
func (s *Server) PostSetup(
	_ context.Context,
	_ PostSetupRequestObject,
) (PostSetupResponseObject, error) {
	return PostSetup500JSONResponse(newError("not_implemented",
		"setup submit not yet implemented (Phase 8 Plan 08-02)")), nil
}

package api

// setup_handler.go — Phase 8 Plan 08-02 final implementation.
//
// Three strict-server methods implementing the wizard surface
// declared in api/openapi.yaml (Plan 08-01 Task 1):
//
//   - GetSetupStatus            GET  /api/v1/setup/status
//   - PostSetupValidateDataDir  POST /api/v1/setup/validate-data-dir
//   - PostSetup                 POST /api/v1/setup
//
// All three are thin shims — the side-effecting work lives in
// internal/firstrun (validate.go for the refusal pipeline, submit.go
// for the mkdir+config+migrate+grants pipeline). Keeping the handler
// thin matches ARCHITECTURE.md §13 anti-pattern 1 ("handler should be
// translate-call-translate").
//
// File layout (per Plan 08-01 revision): NO `phase8_stubs.go`.
// Each downstream wave owns a dedicated handler file. 08-01 landed a
// placeholder version of THIS file (3 stub methods returning
// "not implemented"); this plan REPLACES that file with the real
// methods.

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/matthewoden/jasper/backend/internal/firstrun"
)

// GetSetupStatus reports whether the first-run wizard has completed.
// The contract (D-04 / openapi.yaml SetupStatus.firstRun):
//
//   - true  when <dataDir>/storage/config.json does NOT exist
//   - false when it does
//
// The SPA polls this on initial load so it can render either the
// wizard or the steady-state shell. The firstrun.RedirectMiddleware
// also gates non-/setup routes server-side, so the SPA's branch is
// belt-and-suspenders (avoids a render flash if JS evaluates before
// the middleware redirects).
//
//nolint:revive // generated interface method name
func (s *Server) GetSetupStatus(
	_ context.Context,
	_ GetSetupStatusRequestObject,
) (GetSetupStatusResponseObject, error) {
	cfgPath := filepath.Join(s.dataDir, "storage", "config.json")
	_, err := os.Stat(cfgPath)
	firstRun := errors.Is(err, fs.ErrNotExist)
	return GetSetupStatus200JSONResponse{FirstRun: firstRun}, nil
}

// PostSetupValidateDataDir runs the four D-08 refusal rules
// (parent_missing, nested_vault, unwritable, non_ascii) on the
// candidate data-dir. Returns 200 + Valid:true when the path passes
// all four; 200 + Valid:false + Code + Message when it fails any one.
// The 400 path is reserved for missing/malformed body.
//
// The locked refusal codes/strings live in firstrun/validate.go; we
// cast the package-local RefusalCode to the wire-format string here.
// Per UI-SPEC §Copywriting Contract: the strings are pinned and a
// drift here breaks the ui-checker gate. The cast preserves them
// byte-for-byte.
//
//nolint:revive // generated interface method name
func (s *Server) PostSetupValidateDataDir(
	_ context.Context,
	req PostSetupValidateDataDirRequestObject,
) (PostSetupValidateDataDirResponseObject, error) {
	if req.Body == nil {
		// Wire envelope is fixed: SetupValidateResponse.valid (bool) +
		// optional code/message. A truly malformed body lands in the
		// strict-server's own 400 path; we surface a structured 200
		// with valid=false for an empty payload so the SPA's form
		// validation can render a clear "path is required" hint
		// without a separate error channel.
		emptyCode := SetupValidateResponseCode(firstrun.RefusalParentMissing)
		emptyMsg := "Pick a data-dir path."
		return PostSetupValidateDataDir200JSONResponse{
			Valid:   false,
			Code:    &emptyCode,
			Message: &emptyMsg,
		}, nil
	}
	res := firstrun.ValidateDataDir(req.Body.Path)
	if res.Valid {
		return PostSetupValidateDataDir200JSONResponse{Valid: true}, nil
	}
	code := SetupValidateResponseCode(res.Code)
	msg := res.Message
	return PostSetupValidateDataDir200JSONResponse{
		Valid:   false,
		Code:    &code,
		Message: &msg,
	}, nil
}

// PostSetup runs the wizard submit pipeline (firstrun.RunSetup).
// On success returns 200 + Ok:true; the SPA reloads itself and the
// firstrun middleware now passes through. On any failure returns 500
// with the wrapped error message — the user retries with the
// underlying problem fixed (e.g. free up disk space, choose a
// different path).
//
// migrationsFS is REQUIRED for RunSetup to apply schema migrations
// against the new data-dir. It's plumbed in via Server.SetMigrationsFS
// at app.New / lifecycle.Run; missing it is a programmer error so we
// 500 with a clear "not configured" message rather than silently
// proceeding.
//
//nolint:revive // generated interface method name
func (s *Server) PostSetup(
	ctx context.Context,
	req PostSetupRequestObject,
) (PostSetupResponseObject, error) {
	if req.Body == nil {
		return PostSetup400JSONResponse(newError("invalid_request", "request body required")), nil
	}
	if s.migrationsFS == nil {
		s.log.Error("PostSetup: migrationsFS not wired on Server; app.New / lifecycle.Run must call SetMigrationsFS")
		return PostSetup500JSONResponse(newError("setup_misconfigured",
			"server not configured with embedded migrations FS")), nil
	}

	sr := firstrun.SetupRequest{
		DataDir:              req.Body.DataDir,
		Theme:                string(req.Body.Theme),
		McpEnabled:           req.Body.McpEnabled,
		DailyTemplate:        req.Body.DailyTemplate,
		CreateTodayDailyNote: req.Body.CreateTodayDailyNote,
	}
	for _, g := range req.Body.McpGrants {
		sr.McpGrants = append(sr.McpGrants, firstrun.SetupGrantSeed{
			Folder: g.Folder,
			Level:  int(g.Level),
		})
	}
	if err := firstrun.RunSetup(ctx, sr, s.migrationsFS); err != nil {
		s.log.Error("PostSetup: setup failed",
			"err", err,
			"data_dir", req.Body.DataDir,
		)
		return PostSetup500JSONResponse(newError("setup_failed", err.Error())), nil
	}
	return PostSetup200JSONResponse{Ok: true}, nil
}

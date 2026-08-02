package api

import (
	"context"
	"errors"
	"io/fs"
	"os"

	"github.com/matthewoden/jasper/backend/internal/firstrun"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

// GetSetupStatus reports whether the first-run wizard has completed.
// Returns firstRun:true when <vault>/.jasper/config.json does not exist.
// The SPA polls this on initial load to decide wizard vs. steady-state shell.
//
//nolint:revive // generated interface method name
func (s *Server) GetSetupStatus(
	_ context.Context,
	_ GetSetupStatusRequestObject,
) (GetSetupStatusResponseObject, error) {
	cfgPath := vault.ConfigPath(s.dataDir)
	_, err := os.Stat(cfgPath)
	firstRun := errors.Is(err, fs.ErrNotExist)
	return GetSetupStatus200JSONResponse{FirstRun: firstRun}, nil
}

// PostSetupValidateDataDir runs the four refusal rules
// (parent_missing, nested_vault, unwritable, non_ascii) on the candidate
// data-dir. Returns 200 + Valid:true when all pass; 200 + Valid:false + Code
// + Message on any failure. 400 is reserved for missing/malformed body.
//
// Refusal codes live in firstrun/validate.go; the cast preserves the strings
// byte-for-byte for the copywriting contract.
//
//nolint:revive // generated interface method name
func (s *Server) PostSetupValidateDataDir(
	_ context.Context,
	req PostSetupValidateDataDirRequestObject,
) (PostSetupValidateDataDirResponseObject, error) {
	if req.Body == nil {
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

// PostSetup runs the wizard submit pipeline (firstrun.RunSetup). On success
// returns 200 + Ok:true; on failure returns 500 with the wrapped error so the
// user can retry. migrationsFS is checked for nil as a startup-config guard:
// a missing FS means SetMigrationsFS was never called, which is a 500.
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
		DailyTemplate:        req.Body.DailyTemplate,
		CreateTodayDailyNote: req.Body.CreateTodayDailyNote,
	}
	// accent/readingFont are optional in SetupRequest; a nil pointer means the
	// wizard omitted them, so leave the field empty and let CreateVault apply
	// the config.Defaults() value.
	if req.Body.Accent != nil {
		sr.Accent = string(*req.Body.Accent)
	}
	if req.Body.ReadingFont != nil {
		sr.ReadingFont = string(*req.Body.ReadingFont)
	}
	if req.Body.McpGrants != nil {
		for _, g := range *req.Body.McpGrants {
			sr.McpGrants = append(sr.McpGrants, firstrun.SetupGrantSeed{
				Folder: g.Folder,
				Level:  int(g.Level),
			})
		}
	}
	if err := firstrun.RunSetup(ctx, sr); err != nil {
		s.log.Error(
			"PostSetup: setup failed",
			"err", err,
			"data_dir", req.Body.DataDir,
		)
		return PostSetup500JSONResponse(newError("setup_failed", err.Error())), nil
	}
	return PostSetup200JSONResponse{Ok: true}, nil
}

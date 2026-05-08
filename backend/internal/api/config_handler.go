package api

import (
	"context"
	"errors"

	"github.com/matthewoden/jasper/backend/internal/config"
)

// GetConfig implements GET /api/v1/config. Returns the persisted config
// from <dataDir>/storage/config.json, or DefaultConfig() if the file
// is missing or malformed (config.Load handles fallback per D-10).
//
// Wire-format errors NEVER leak filesystem paths or stack traces
// (T-05-03-04: generic 500 on Load error; full err logged server-side).
//
//nolint:revive // generated interface name
func (s *Server) GetConfig(
	_ context.Context,
	_ GetConfigRequestObject,
) (GetConfigResponseObject, error) {
	cfg, err := config.Load(s.dataDir, s.log)
	if err != nil {
		s.log.Error("GetConfig: load failed",
			"dataDir", s.dataDir, "err", err)
		return nil, errors.New("could not load config")
	}
	return GetConfig200JSONResponse(toWireConfig(cfg)), nil
}

// PutConfig implements PUT /api/v1/config. Replaces the whole document
// atomically (fsstore.AtomicWrite via config.Save).
//
// Validation is layered:
//   - oapi-codegen / openapi3-filter validates the body against the
//     Config schema BEFORE this handler runs (additionalProperties:
//     false / minLength / enum / etc.); a violation returns 400 from
//     the strict-server middleware automatically.
//   - Inside this handler we still nil-check req.Body for safety
//     (mirrors PostFolders pattern).
//
//nolint:revive // generated interface name
func (s *Server) PutConfig(
	_ context.Context,
	req PutConfigRequestObject,
) (PutConfigResponseObject, error) {
	if req.Body == nil {
		return PutConfig400JSONResponse(newError("invalid_request",
			"request body required")), nil
	}
	cfg := fromWireConfig(*req.Body)
	if err := config.Save(s.dataDir, cfg); err != nil {
		s.log.Error("PutConfig: save failed",
			"dataDir", s.dataDir, "err", err)
		return nil, errors.New("could not save config")
	}
	return PutConfig200JSONResponse(toWireConfig(cfg)), nil
}

// toWireConfig maps the internal config.Config to the generated wire type
// (api.Config from openapi_gen.go). The two structs are structurally
// isomorphic by design; the generated Config.DailyNotes and Config.Editor
// are anonymous structs so we initialize them with struct literals.
//
// NOTE: config.Editor.LineHeight is float64; the generated Config.Editor.LineHeight
// is float32 (oapi-codegen maps OpenAPI `number` to float32 by default when
// no format qualifier is specified). The cast preserves the value within
// the precision of float32 — which is adequate for a 1.0–3.0 range with
// 1-decimal-place resolution.
func toWireConfig(c config.Config) Config {
	return Config{
		AppName: c.AppName,
		Theme:   ConfigTheme(c.Theme),
		DailyNotes: struct {
			Folder   string `json:"folder"`
			Template string `json:"template"`
		}{
			Folder:   c.DailyNotes.Folder,
			Template: c.DailyNotes.Template,
		},
		Editor: struct {
			FontSize   int     `json:"fontSize"`
			LineHeight float32 `json:"lineHeight"`
			VimMode    bool    `json:"vimMode"`
		}{
			FontSize:   c.Editor.FontSize,
			LineHeight: float32(c.Editor.LineHeight),
			VimMode:    c.Editor.VimMode,
		},
	}
}

func fromWireConfig(w Config) config.Config {
	return config.Config{
		AppName: w.AppName,
		Theme:   string(w.Theme),
		DailyNotes: config.DailyNotes{
			Folder:   w.DailyNotes.Folder,
			Template: w.DailyNotes.Template,
		},
		Editor: config.Editor{
			FontSize:   w.Editor.FontSize,
			LineHeight: float64(w.Editor.LineHeight),
			VimMode:    w.Editor.VimMode,
		},
	}
}

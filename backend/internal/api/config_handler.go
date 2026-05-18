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
//   - ConfigStrictBodyMiddleware (config_validate.go) validates the body
//     BEFORE this handler runs: unknown fields → 400, theme enum → 400,
//     string length constraints → 400, numeric range constraints → 400.
//     NOTE: oapi-codegen's strict-server does NOT automatically invoke
//     openapi3filter request validation in this deployment, so explicit
//     range/length checks in ConfigStrictBodyMiddleware are required.
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
	// Phase 8 Plan 08-01: Mcp + Server are pointer fields with
	// omitempty in the generated wire type so existing clients (Phase
	// 5–7) that ignored these blocks still see the same shape. We
	// always emit them server-side so the wizard + the listener can
	// rely on the values being present on round-trip.
	server := struct {
		DataDir string `json:"dataDir"`
		Port    int    `json:"port"`
	}{
		DataDir: c.Server.DataDir,
		Port:    c.Server.Port,
	}
	mcp := struct {
		Bind    string `json:"bind"`
		Enabled bool   `json:"enabled"`
		Port    int    `json:"port"`
	}{
		Bind:    c.MCP.Bind,
		Enabled: c.MCP.Enabled,
		Port:    c.MCP.Port,
	}
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
		Server: &server,
		Mcp:    &mcp,
	}
}

func fromWireConfig(w Config) config.Config {
	// Phase 8 Plan 08-01: pull Server / MCP off the optional wire
	// blocks; fall back to package defaults so a PUT body that omits
	// either block doesn't zero the stored values. Plan 08-02's
	// wizard submit ALWAYS sends both blocks; pre-Phase-8 clients
	// (which omit them) keep working.
	out := config.Config{
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
		Server: config.ServerConfig{Port: 6683, DataDir: ""}, // D-50 default
		MCP:    config.MCPConfig{Enabled: false, Port: 6684, Bind: "127.0.0.1"},
	}
	if w.Server != nil {
		out.Server.Port = w.Server.Port
		out.Server.DataDir = w.Server.DataDir
		if out.Server.Port == 0 {
			out.Server.Port = 6683
		}
	}
	if w.Mcp != nil {
		out.MCP.Enabled = w.Mcp.Enabled
		out.MCP.Port = w.Mcp.Port
		out.MCP.Bind = w.Mcp.Bind
		if out.MCP.Port == 0 {
			out.MCP.Port = 6684
		}
		if out.MCP.Bind == "" {
			out.MCP.Bind = "127.0.0.1"
		}
	}
	return out
}

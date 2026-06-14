package api

import (
	"context"
	"errors"

	"github.com/matthewoden/jasper/backend/internal/config"
)

// GetConfig implements GET /api/v1/config. Returns the persisted config
// from <vault>/.jasper/config.json, or DefaultConfig() if the file is
// missing or malformed.
//
// Wire-format errors never leak filesystem paths or stack traces:
// generic 500 on Load error; full err logged server-side.
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

// PutConfig implements PUT /api/v1/config. Replaces the whole document atomically.
//
// Validation is layered:
//   - ConfigStrictBodyMiddleware (config_validate.go) runs before this handler:
//     unknown fields → 400, theme enum → 400, length/range constraints → 400.
//     oapi-codegen's strict-server does not automatically invoke openapi3filter
//     validation, so explicit checks in ConfigStrictBodyMiddleware are required.
//   - This handler still nil-checks req.Body for safety.
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
	if err := config.SaveMerged(s.dataDir, cfg, s.log); err != nil {
		s.log.Error("PutConfig: save failed",
			"dataDir", s.dataDir, "err", err)
		return nil, errors.New("could not save config")
	}
	return PutConfig200JSONResponse(toWireConfig(cfg)), nil
}

func toWireConfig(c config.Config) Config {
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
	var displayName *string
	if c.DisplayName != "" {
		dn := c.DisplayName
		displayName = &dn
	}
	return Config{
		AppName:     c.AppName,
		DisplayName: displayName,
		Theme:       ConfigTheme(c.Theme),
		DailyNotes: struct {
			Folder   string `json:"folder"`
			Template string `json:"template"`
		}{
			Folder:   c.DailyNotes.Folder,
			Template: c.DailyNotes.Template,
		},
		Editor: struct {
			AutosaveMs int     `json:"autosaveMs"`
			FontSize   int     `json:"fontSize"`
			LineHeight float64 `json:"lineHeight"`
			VimMode    bool    `json:"vimMode"`
		}{
			AutosaveMs: c.Editor.AutosaveMs,
			FontSize:   c.Editor.FontSize,
			LineHeight: c.Editor.LineHeight,
			VimMode:    c.Editor.VimMode,
		},
		Server: &server,
		Mcp:    &mcp,
	}
}

func fromWireConfig(w Config) config.Config {
	var displayName string
	if w.DisplayName != nil {
		displayName = *w.DisplayName
	}
	out := config.Config{
		AppName:     w.AppName,
		DisplayName: displayName,
		Theme:       string(w.Theme),
		DailyNotes: config.DailyNotes{
			Folder:   w.DailyNotes.Folder,
			Template: w.DailyNotes.Template,
		},
		Editor: config.Editor{
			AutosaveMs: w.Editor.AutosaveMs,
			FontSize:   w.Editor.FontSize,
			LineHeight: w.Editor.LineHeight,
			VimMode:    w.Editor.VimMode,
		},
		Server: config.ServerConfig{Port: 6683, DataDir: ""},
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

package api

import (
	"context"
	"errors"
	"path/filepath"

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/vault"
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

	// Sync display_name to app.json so GET /vault/current reflects the new name.
	// Best-effort: log on failure but do not fail the request (config.json is the primary store).
	if appJSONPath, err := vault.AppJSONPath(); err == nil {
		if state, err := vault.LoadAppJSON(appJSONPath); err == nil {
			dn := cfg.DisplayName
			if dn == "" {
				dn = filepath.Base(s.dataDir)
			}
			for i := range state.RecentVaults {
				if state.RecentVaults[i].Path == s.dataDir {
					state.RecentVaults[i].DisplayName = dn
					break
				}
			}
			vault.TouchOpened(state, s.dataDir, dn)
			if err := vault.SaveAppJSON(appJSONPath, state); err != nil {
				s.log.Warn("PutConfig: sync app.json failed", "err", err)
			}
		}
	}

	return PutConfig200JSONResponse(toWireConfig(cfg)), nil
}

func toWireConfig(c config.Config) Config {
	server := struct {
		Bind    string `json:"bind"`
		DataDir string `json:"dataDir"`
		Port    int    `json:"port"`
	}{
		Bind:    c.Server.Bind,
		DataDir: c.Server.DataDir,
		Port:    c.Server.Port,
	}
	mcp := struct {
		Bind string `json:"bind"`
		Port int    `json:"port"`
	}{
		Bind: c.MCP.Bind,
		Port: c.MCP.Port,
	}
	var displayName *string
	if c.DisplayName != "" {
		dn := c.DisplayName
		displayName = &dn
	}
	accent := ConfigAccent(c.Accent)
	readingFont := ConfigReadingFont(c.ReadingFont)
	return Config{
		AppName:     c.AppName,
		DisplayName: displayName,
		Theme:       ConfigTheme(c.Theme),
		Accent:      &accent,
		ReadingFont: &readingFont,
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
		Server: config.ServerConfig{Port: 6683, DataDir: "", Bind: "127.0.0.1"},
		MCP:    config.MCPConfig{Port: 6684, Bind: "127.0.0.1"},
	}
	if w.Accent != nil {
		out.Accent = string(*w.Accent)
	}
	if w.ReadingFont != nil {
		out.ReadingFont = string(*w.ReadingFont)
	}
	if w.Server != nil {
		out.Server.Port = w.Server.Port
		out.Server.DataDir = w.Server.DataDir
		out.Server.Bind = w.Server.Bind
		if out.Server.Port == 0 {
			out.Server.Port = 6683
		}
		if out.Server.Bind == "" {
			out.Server.Bind = "127.0.0.1"
		}
	}
	if w.Mcp != nil {
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

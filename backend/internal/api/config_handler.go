package api

import (
	"context"
	"encoding/json"
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

	// Sync display name to app.json so GET /vault/current reflects the new name.
	// Best-effort: log on failure but do not fail the request (config.json is the primary store).
	// D-05: config.Config.DisplayName is gone; the vault's name is its folder name.
	if appJSONPath, err := vault.AppJSONPath(); err == nil {
		if state, err := vault.LoadAppJSON(appJSONPath); err == nil {
			dn := filepath.Base(s.dataDir)
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

// PatchConfig implements PATCH /api/v1/config. Writes only the keys present
// in the request body through the serialised sparse-overlay primitive
// (config.SaveMergedPartial); every other field on disk, including
// unmanaged/hand-added keys, is left untouched.
//
// Deliberately does NOT sync app.json's display name the way PutConfig does:
// that sync derives the name from filepath.Base(s.dataDir), not from any
// Config field, so no patchable field can change it, and PUT /config (Reset,
// first-run) still performs the sync — it is not lost by this handler
// skipping it.
//
//nolint:revive // generated interface name
func (s *Server) PatchConfig(
	_ context.Context,
	req PatchConfigRequestObject,
) (PatchConfigResponseObject, error) {
	if req.Body == nil {
		return PatchConfig400JSONResponse(newError("invalid_request",
			"request body required")), nil
	}

	overlay, err := fromWirePatch(*req.Body)
	if err != nil {
		return PatchConfig400JSONResponse(newError("invalid_request",
			"could not decode request body")), nil
	}

	if err := config.SaveMergedPartial(s.dataDir, overlay, s.log); err != nil {
		s.log.Error("PatchConfig: save failed",
			"dataDir", s.dataDir, "err", err)
		return nil, errors.New("could not save config")
	}

	cfg, err := config.Load(s.dataDir, s.log)
	if err != nil {
		s.log.Error("PatchConfig: reload after save failed",
			"dataDir", s.dataDir, "err", err)
		return nil, errors.New("could not load config")
	}

	return PatchConfig200JSONResponse(toWireConfig(cfg)), nil
}

// fromWirePatch builds a sparse write overlay from a ConfigPatch. Every
// ConfigPatch field is an optional pointer (oapi-codegen's `,omitempty` on
// every non-required property), so marshaling w drops every nil field and
// keeps every present field — including pointer-to-zero-value ones — and the
// marshal/unmarshal round-trip through a raw-message map *is* the sparse
// overlay. Do not replace this with a hand-written nil-check ladder; the
// round-trip already produces exactly the right shape.
func fromWirePatch(w ConfigPatch) (map[string]json.RawMessage, error) {
	data, err := json.Marshal(w)
	if err != nil {
		return nil, err
	}
	var overlay map[string]json.RawMessage
	if err := json.Unmarshal(data, &overlay); err != nil {
		return nil, err
	}
	return overlay, nil
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
	auditLog := c.MCP.AuditLog
	mcp := struct {
		AuditLog *bool  `json:"auditLog,omitempty"`
		Bind     string `json:"bind"`
		Port     int    `json:"port"`
	}{
		AuditLog: &auditLog,
		Bind:     c.MCP.Bind,
		Port:     c.MCP.Port,
	}
	templates := struct {
		Folder string `json:"folder"`
	}{
		Folder: c.Templates.Folder,
	}
	accent := ConfigAccent(c.Accent)
	readingFont := ConfigReadingFont(c.ReadingFont)
	showProperties := c.Editor.ShowProperties
	autoPair := c.Editor.AutoPair
	foldGutter := c.Editor.FoldGutter
	lineNumbers := c.Editor.LineNumbers
	lineWidth := c.Editor.LineWidth
	return Config{
		AppName:     c.AppName,
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
			AutoPair       *bool   `json:"autoPair,omitempty"`
			AutosaveMs     int     `json:"autosaveMs"`
			FoldGutter     *bool   `json:"foldGutter,omitempty"`
			FontSize       int     `json:"fontSize"`
			LineHeight     float64 `json:"lineHeight"`
			LineNumbers    *bool   `json:"lineNumbers,omitempty"`
			LineWidth      *int    `json:"lineWidth,omitempty"`
			ShowProperties *bool   `json:"showProperties,omitempty"`
		}{
			AutoPair:       &autoPair,
			AutosaveMs:     c.Editor.AutosaveMs,
			FoldGutter:     &foldGutter,
			FontSize:       c.Editor.FontSize,
			LineHeight:     c.Editor.LineHeight,
			LineNumbers:    &lineNumbers,
			LineWidth:      &lineWidth,
			ShowProperties: &showProperties,
		},
		Server:    &server,
		Mcp:       &mcp,
		Templates: &templates,
	}
}

func fromWireConfig(w Config) config.Config {
	defaults := config.Defaults()
	out := config.Config{
		AppName: w.AppName,
		Theme:   string(w.Theme),
		DailyNotes: config.DailyNotes{
			Folder:   w.DailyNotes.Folder,
			Template: w.DailyNotes.Template,
		},
		Editor: config.Editor{
			AutosaveMs:     w.Editor.AutosaveMs,
			FontSize:       w.Editor.FontSize,
			LineHeight:     w.Editor.LineHeight,
			ShowProperties: defaults.Editor.ShowProperties,
			AutoPair:       defaults.Editor.AutoPair,
			FoldGutter:     defaults.Editor.FoldGutter,
			LineNumbers:    defaults.Editor.LineNumbers,
			LineWidth:      defaults.Editor.LineWidth,
		},
		Server:    config.ServerConfig{Port: 6683, DataDir: "", Bind: "127.0.0.1"},
		MCP:       config.MCPConfig{Port: 6684, Bind: "127.0.0.1", AuditLog: defaults.MCP.AuditLog},
		Templates: config.Templates{Folder: defaults.Templates.Folder},
	}
	if w.Editor.ShowProperties != nil {
		out.Editor.ShowProperties = *w.Editor.ShowProperties
	}
	if w.Editor.AutoPair != nil {
		out.Editor.AutoPair = *w.Editor.AutoPair
	}
	if w.Editor.FoldGutter != nil {
		out.Editor.FoldGutter = *w.Editor.FoldGutter
	}
	if w.Editor.LineNumbers != nil {
		out.Editor.LineNumbers = *w.Editor.LineNumbers
	}
	if w.Editor.LineWidth != nil {
		out.Editor.LineWidth = *w.Editor.LineWidth
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
		if w.Mcp.AuditLog != nil {
			out.MCP.AuditLog = *w.Mcp.AuditLog
		}
	}
	if w.Templates != nil {
		out.Templates.Folder = w.Templates.Folder
	}
	return out
}

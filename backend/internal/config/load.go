package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
)

// withEnvMCPPort applies the JASPER_MCP_PORT override (highest precedence) so
// each E2E test binary can bind its MCP listener to its own ephemeral port,
// eliminating contention on the fixed default (6684) when many test binaries
// run in parallel. Ignored when unset or invalid. Applied uniformly to every
// Load() return so first-boot and the vault-switch listener both honor it.
func withEnvMCPPort(cfg Config) Config {
	if v := os.Getenv("JASPER_MCP_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil && p > 0 && p <= 65535 {
			cfg.MCP.Port = p
		}
	}
	return cfg
}

// configPath returns <dataDir>/.jasper/config.json — the on-disk location of
// the per-vault config file. MUST stay byte-for-byte aligned with the result
// of vault.ConfigPath(dataDir). The ".jasper" literal is inlined here to
// break the vault → config → vault import cycle introduced when CreateVault
// began calling config.Save.
func configPath(dataDir string) string {
	return filepath.Join(dataDir, ".jasper", "config.json")
}

// decodeField is the per-field leniency primitive (ADR-0020). Never decode a
// whole struct in one Unmarshal: that fails the ENTIRE struct the instant one
// field has the wrong type, which is the data-loss bug this package closes.
func decodeField[T any](raw map[string]json.RawMessage, jsonKey, fieldPath, path string, target *T, log *slog.Logger) {
	v, ok := raw[jsonKey]
	if !ok {
		return
	}
	// A literal JSON null unmarshals into most Go destinations as a
	// successful no-op (err == nil, target left untouched) rather than a
	// type-mismatch error, so it must be checked explicitly — otherwise
	// this exact fallback happens with no warning at all.
	if string(v) == "null" {
		log.Warn("config: field fell back to default",
			"field", fieldPath, "reason", "null value", "path", path)
		return
	}
	if err := json.Unmarshal(v, target); err != nil {
		log.Warn("config: field fell back to default",
			"field", fieldPath, "reason", "type mismatch", "path", path, "err", err)
	}
}

// decodeSection unmarshals raw[jsonKey] into its own map[string]json.RawMessage
// for a subsequent per-field pass, or returns nil if the key is absent or is
// not itself a JSON object. A malformed section degrades to nil — every
// field inside it keeps its Defaults() seed — rather than failing the whole
// document; this is the per-field leniency guarantee applied one level
// deeper, matching
// the nested-object recursion the interfaces contract requires for
// dailyNotes/editor/server/mcp/templates.
func decodeSection(raw map[string]json.RawMessage, jsonKey, path string, log *slog.Logger) map[string]json.RawMessage {
	v, ok := raw[jsonKey]
	if !ok {
		return nil
	}
	// A literal JSON null unmarshals into a nil map with err == nil (a
	// successful no-op), not a type-mismatch error — check for it
	// explicitly so every field in this section still gets its fallback
	// warning instead of silently keeping its Defaults() seed.
	if string(v) == "null" {
		log.Warn("config: section fell back to defaults",
			"field", jsonKey, "reason", "null value", "path", path)
		return nil
	}
	var nested map[string]json.RawMessage
	if err := json.Unmarshal(v, &nested); err != nil {
		log.Warn("config: section fell back to defaults",
			"field", jsonKey, "reason", "type mismatch", "path", path, "err", err)
		return nil
	}
	return nested
}

// warnOutOfRange logs the fallback warning for a well-typed value that
// fails its range/enum check. Clamping to the nearest bound is forbidden —
// the caller must revert the field to its own Defaults() value, never a
// value the user did not type.
func warnOutOfRange(log *slog.Logger, fieldPath, path string) {
	log.Warn("config: field fell back to default",
		"field", fieldPath, "reason", "out of range", "path", path)
}

// decodeDailyNotes decodes and range-validates the dailyNotes section.
// Bounds: template max 1024 chars.
func decodeDailyNotes(raw map[string]json.RawMessage, path string, log *slog.Logger, cfg *DailyNotes) {
	nested := decodeSection(raw, "dailyNotes", path, log)
	if nested == nil {
		return
	}
	decodeField(nested, "template", "dailyNotes.template", path, &cfg.Template, log)

	if len(cfg.Template) > 1024 {
		warnOutOfRange(log, "dailyNotes.template", path)
		cfg.Template = Defaults().DailyNotes.Template
	}
}

// decodeEditor decodes and range-validates the editor section. Bounds:
// fontSize 8-32, lineHeight 1.0-3.0, autosaveMs 250-10000, lineWidth
// 400-2000. The boolean fields have no range to enforce.
func decodeEditor(raw map[string]json.RawMessage, path string, log *slog.Logger, cfg *Editor) {
	nested := decodeSection(raw, "editor", path, log)
	if nested == nil {
		return
	}
	decodeField(nested, "fontSize", "editor.fontSize", path, &cfg.FontSize, log)
	decodeField(nested, "lineHeight", "editor.lineHeight", path, &cfg.LineHeight, log)
	decodeField(nested, "autosaveMs", "editor.autosaveMs", path, &cfg.AutosaveMs, log)
	decodeField(nested, "showProperties", "editor.showProperties", path, &cfg.ShowProperties, log)
	decodeField(nested, "autoPair", "editor.autoPair", path, &cfg.AutoPair, log)
	decodeField(nested, "foldGutter", "editor.foldGutter", path, &cfg.FoldGutter, log)
	decodeField(nested, "lineNumbers", "editor.lineNumbers", path, &cfg.LineNumbers, log)
	decodeField(nested, "lineWidth", "editor.lineWidth", path, &cfg.LineWidth, log)

	def := Defaults().Editor
	if cfg.FontSize < 8 || cfg.FontSize > 32 {
		warnOutOfRange(log, "editor.fontSize", path)
		cfg.FontSize = def.FontSize
	}
	if cfg.LineHeight < 1.0 || cfg.LineHeight > 3.0 {
		warnOutOfRange(log, "editor.lineHeight", path)
		cfg.LineHeight = def.LineHeight
	}
	if cfg.AutosaveMs < 250 || cfg.AutosaveMs > 10000 {
		warnOutOfRange(log, "editor.autosaveMs", path)
		cfg.AutosaveMs = def.AutosaveMs
	}
	if cfg.LineWidth < 400 || cfg.LineWidth > 2000 {
		warnOutOfRange(log, "editor.lineWidth", path)
		cfg.LineWidth = def.LineWidth
	}
}

// decodeServerConfig decodes and range-validates the server section. Port
// 0/absent silently defaults to 6683 (the pre-existing back-compat
// contract, not a leniency fallback); a present-but-out-of-range port
// reverts to 6683 with a warn. Bind "" silently defaults to "127.0.0.1".
func decodeServerConfig(raw map[string]json.RawMessage, path string, log *slog.Logger, cfg *ServerConfig) {
	nested := decodeSection(raw, "server", path, log)
	if nested == nil {
		return
	}
	decodeField(nested, "port", "server.port", path, &cfg.Port, log)
	decodeField(nested, "dataDir", "server.dataDir", path, &cfg.DataDir, log)
	decodeField(nested, "bind", "server.bind", path, &cfg.Bind, log)

	switch {
	case cfg.Port == 0:
		cfg.Port = 6683
	case cfg.Port < 1 || cfg.Port > 65535:
		warnOutOfRange(log, "server.port", path)
		cfg.Port = 6683
	}
	if cfg.Bind == "" {
		cfg.Bind = "127.0.0.1"
	}
}

// decodeMCPConfig decodes and range-validates the mcp section. Port
// 0/absent silently defaults to 6684; a present-but-out-of-range port
// reverts to 6684 with a warn. Bind "" silently defaults to "127.0.0.1".
// A legacy on-disk "enabled" key (MCPConfig.Enabled was deleted in 32-01)
// is simply an unrecognized key within this section's raw map — it is
// never referenced below, so it is silently dropped, not fallback-warned.
func decodeMCPConfig(raw map[string]json.RawMessage, path string, log *slog.Logger, cfg *MCPConfig) {
	nested := decodeSection(raw, "mcp", path, log)
	if nested == nil {
		return
	}
	decodeField(nested, "port", "mcp.port", path, &cfg.Port, log)
	decodeField(nested, "bind", "mcp.bind", path, &cfg.Bind, log)
	decodeField(nested, "auditLog", "mcp.auditLog", path, &cfg.AuditLog, log)

	switch {
	case cfg.Port == 0:
		cfg.Port = 6684
	case cfg.Port < 1 || cfg.Port > 65535:
		warnOutOfRange(log, "mcp.port", path)
		cfg.Port = 6684
	}
	if cfg.Bind == "" {
		cfg.Bind = "127.0.0.1"
	}
}

// decodeTemplates decodes and range-validates the templates section.
// Bounds: folder max 64 chars.
func decodeTemplates(raw map[string]json.RawMessage, path string, log *slog.Logger, cfg *Templates) {
	nested := decodeSection(raw, "templates", path, log)
	if nested == nil {
		return
	}
	decodeField(nested, "folder", "templates.folder", path, &cfg.Folder, log)

	if len(cfg.Folder) > 64 {
		warnOutOfRange(log, "templates.folder", path)
		cfg.Folder = Defaults().Templates.Folder
	}
}

// Load reads the persisted config with per-field leniency (ADR-0020): a bad
// field reverts to its own default — never clamped to a bound — while every
// sibling keeps its on-disk value. Unparseable JSON is left on disk for
// forensics rather than overwritten.
//
// Returns an error only when the disk is unreadable for non-not-exist reasons.
// Startup is not gated on config.
func Load(dataDir string, log *slog.Logger) (Config, error) {
	mu.Lock()
	defer mu.Unlock()
	return loadLocked(dataDir, log)
}

// loadLocked is Load's body. Takes the exclusive lock (via Load), not a
// read lock, because its first-run branch writes: it calls saveLocked
// directly instead of the exported Save, since mu is already held and Save
// would re-acquire it and deadlock (see mu's doc comment in save.go). Never
// call this without mu held, and never have it acquire mu itself.
func loadLocked(dataDir string, log *slog.Logger) (Config, error) {
	path := configPath(dataDir)
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		cfg := DefaultConfig()
		if writeErr := saveLocked(dataDir, cfg); writeErr != nil {
			log.Warn("config: default emit failed",
				"path", path, "err", writeErr)
		} else {
			log.Info("config: defaults written on first run", "path", path)
		}
		return withEnvMCPPort(cfg), nil
	}
	if err != nil {
		return Config{}, fmt.Errorf("config read: %w", err)
	}

	// Two-pass decode: unmarshal into a raw key->bytes map first. There is
	// no strict-decoder option enabled here — that would only solve
	// unknown-key leniency; see decodeField's doc comment for why a
	// single-shot Decode/Unmarshal against the full Config struct cannot
	// give per-field leniency regardless of any decoder option.
	var topRaw map[string]json.RawMessage
	if err := json.Unmarshal(raw, &topRaw); err != nil {
		// Genuinely unparseable JSON (not merely "wrong shape") — the
		// whole-document fallback still applies here; the file is left
		// untouched on disk for forensics.
		log.Warn("config: malformed JSON; falling back to defaults",
			"path", path, "err", err)
		return withEnvMCPPort(DefaultConfig()), nil
	}

	cfg := DefaultConfig()

	decodeField(topRaw, "appName", "appName", path, &cfg.AppName, log)
	if len(cfg.AppName) < 1 || len(cfg.AppName) > 64 {
		warnOutOfRange(log, "appName", path)
		cfg.AppName = Defaults().AppName
	}

	decodeDailyNotes(topRaw, path, log, &cfg.DailyNotes)
	decodeEditor(topRaw, path, log, &cfg.Editor)
	decodeServerConfig(topRaw, path, log, &cfg.Server)
	decodeMCPConfig(topRaw, path, log, &cfg.MCP)
	decodeTemplates(topRaw, path, log, &cfg.Templates)

	decodeField(topRaw, "accent", "accent", path, &cfg.Accent, log)
	switch cfg.Accent {
	case "purple", "sky", "green", "orange":
	default:
		warnOutOfRange(log, "accent", path)
		cfg.Accent = "purple"
	}

	decodeField(topRaw, "readingFont", "readingFont", path, &cfg.ReadingFont, log)
	if cfg.ReadingFont != "sans" && cfg.ReadingFont != "serif" {
		warnOutOfRange(log, "readingFont", path)
		cfg.ReadingFont = "sans"
	}

	// Runtime theme is always dark, unconditionally — a pin, not a
	// leniency fallback, so this is not gated on decode success and never
	// warns. The "light" value stays in the OpenAPI enum for wire-compat.
	cfg.Theme = "dark"

	return withEnvMCPPort(cfg), nil
}

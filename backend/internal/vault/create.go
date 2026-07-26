package vault

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/matthewoden/jasper/backend/internal/config"
)

// CreateOpts holds the per-vault configuration fields populated by the
// vault-creation wizard or the /vault/create API handler.
type CreateOpts struct {
	// DisplayName is the human-readable vault name. Defaults to
	// filepath.Base(canonical) when empty.
	DisplayName string

	// Theme is "dark" or "light". Defaults to "dark" when empty.
	Theme string

	// DailyTemplate is the per-vault daily-note template string.
	// Stored in .jasper/config.json under daily_notes.template.
	DailyTemplate string

	// Accent is the UI accent selection ("purple"|"sky"|"green"|"orange").
	// Empty keeps the config.Defaults() accent ("purple").
	Accent string

	// ReadingFont is the reading-surface font selection ("sans"|"serif").
	// Empty keeps the config.Defaults() reading font ("sans").
	ReadingFont string
}

// CreateVault initializes a new Jasper vault at canonical and registers it in
// app.json. It does NOT run migrations or open SQLite — the first time the
// server boots into this vault it runs the migration runner against
// <canonical>/.jasper/app.db (lifecycle.bootPerVaultSubsystems).
//
// canonical MUST already be canonicalized (via vault.Canonicalize). The vault
// directory itself need not exist yet; CreateVault creates .jasper/ inside it.
//
// The per-vault config.json is written in the full server-config shape so the
// new-vault writer here and the in-place updater in package config produce
// byte-equivalent files — single shape, single reader (config.Load).
//
// Returns the loaded *AppState after the registration so callers can inspect
// the new entry without re-reading app.json.
func CreateVault(ctx context.Context, canonical string, opts CreateOpts) (*AppState, error) {
	displayName := opts.DisplayName
	if displayName == "" {
		displayName = filepath.Base(canonical)
	}
	theme := opts.Theme
	if theme == "" {
		theme = "dark"
	}

	jasperDir := filepath.Join(canonical, SubdirName)
	if err := os.MkdirAll(jasperDir, 0o700); err != nil {
		return nil, fmt.Errorf("CreateVault: mkdir .jasper/: %w", err)
	}

	cfg := config.Defaults()
	cfg.Server.DataDir = canonical
	cfg.Theme = theme
	if opts.DailyTemplate != "" {
		cfg.DailyNotes.Template = opts.DailyTemplate
	}
	if opts.Accent != "" {
		cfg.Accent = opts.Accent
	}
	if opts.ReadingFont != "" {
		cfg.ReadingFont = opts.ReadingFont
	}

	if err := config.Save(canonical, cfg); err != nil {
		return nil, fmt.Errorf("CreateVault: write config.json: %w", err)
	}

	appJSONPath, err := AppJSONPath()
	if err != nil {
		return nil, fmt.Errorf("CreateVault: resolve app home: %w", err)
	}
	appState, err := LoadAppJSON(appJSONPath)
	if err != nil {
		return nil, fmt.Errorf("CreateVault: load app.json: %w", err)
	}
	TouchOpened(appState, canonical, displayName)
	if err := SaveAppJSON(appJSONPath, appState); err != nil {
		return nil, fmt.Errorf("CreateVault: save app.json: %w", err)
	}
	_ = ctx // reserved for future cancellation hooks; current implementation does no blocking I/O that requires cancellation
	return appState, nil
}

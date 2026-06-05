package vault

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
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

	// MCPEnabled persists the per-vault MCP toggle.
	MCPEnabled bool

	// MigrationsFS is the migrations filesystem to run against the new vault DB.
	// Must be non-nil; callers typically pass migrations.FS (embedded) or a test
	// override.
	MigrationsFS fs.FS
}

// CreateVault initializes a new Jasper vault at canonical, running migrations
// and registering the vault in app.json.
//
// canonical MUST already be canonicalized (via vault.Canonicalize). The vault
// directory itself need not exist yet; CreateVault creates .jasper/ inside it.
//
// Returns the loaded *AppState after the registration so callers can inspect
// the new entry without re-reading app.json.
func CreateVault(ctx context.Context, canonical string, opts CreateOpts) (*AppState, error) {
	if opts.MigrationsFS == nil {
		return nil, fmt.Errorf("CreateVault: opts.MigrationsFS must be non-nil")
	}
	displayName := opts.DisplayName
	if displayName == "" {
		displayName = filepath.Base(canonical)
	}
	theme := opts.Theme
	if theme == "" {
		theme = "dark"
	}

	jasperDir := filepath.Join(canonical, ".jasper")
	if err := os.MkdirAll(jasperDir, 0o700); err != nil {
		return nil, fmt.Errorf("CreateVault: mkdir .jasper/: %w", err)
	}

	type dailyNotesCfg struct {
		Template string `json:"template"`
	}
	type mcpCfg struct {
		Enabled bool `json:"enabled"`
	}
	type perVaultConfig struct {
		DisplayName string        `json:"display_name"`
		CreatedAt   string        `json:"created_at"`
		Theme       string        `json:"theme"`
		DailyNotes  dailyNotesCfg `json:"daily_notes"`
		MCP         mcpCfg        `json:"mcp"`
	}
	cfgData := perVaultConfig{
		DisplayName: displayName,
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		Theme:       theme,
		DailyNotes:  dailyNotesCfg{Template: opts.DailyTemplate},
		MCP:         mcpCfg{Enabled: opts.MCPEnabled},
	}
	cfgBytes, err := json.MarshalIndent(cfgData, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("CreateVault: marshal config: %w", err)
	}
	cfgPath := filepath.Join(jasperDir, "config.json")
	if err := fsstore.AtomicWrite(cfgPath, cfgBytes); err != nil {
		return nil, fmt.Errorf("CreateVault: write config.json: %w", err)
	}

	dbPath := filepath.Join(jasperDir, "app.db")
	backupPath := dbPath + ".backup"
	logsDir := filepath.Join(jasperDir, "logs")
	if err := os.MkdirAll(logsDir, 0o700); err != nil {
		return nil, fmt.Errorf("CreateVault: ensure logs dir: %w", err)
	}
	logsPath := filepath.Join(logsDir, "jasper.log")

	pair, err := sqlite.Open(ctx, dbPath)
	if err != nil {
		return nil, fmt.Errorf("CreateVault: sqlite open: %w", err)
	}
	runner := migrate.NewRunner(migrate.RunnerOptions{
		DBPath:     dbPath,
		BackupPath: backupPath,
		LogsPath:   logsPath,
		Migrations: opts.MigrationsFS,
		Pair:       pair,
	})
	status, runErr := runner.Run(ctx)
	if cerr := pair.Close(); cerr != nil && runErr == nil {
		runErr = cerr
	}
	if runErr != nil {
		return nil, fmt.Errorf("CreateVault: run migrations: %w", runErr)
	}
	if status.State == migrate.StateUnrecoverable {
		return nil, fmt.Errorf("CreateVault: unrecoverable migration state")
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
	return appState, nil
}

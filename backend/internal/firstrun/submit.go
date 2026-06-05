package firstrun

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite" // registers the "sqlite" sql driver

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

// SetupRequest is the in-process form of a wizard submit. The handler
// (api/setup_handler.go) translates the openapi-generated wire type
// into this struct before calling RunSetup, so RunSetup stays
// independent of the api package and is testable without the chi
// router.
type SetupRequest struct {
	// DataDir is the path the user picked in Step 1 of the wizard. The
	// user is allowed to type a tilde-prefixed path like
	// "~/Documents/Jasper" (the wizard input placeholder); RunSetup
	// resolves the tilde against os.UserHomeDir() via
	// firstrun.ResolveDataDir before any filesystem work runs. The
	// resolved absolute path is what gets MkdirAll'd, persisted into
	// cfg.Server.DataDir, and handed to sqlite.Open. RunSetup also
	// re-runs ValidateDataDir against the resolved value as a final
	// gate (T-08-06 — a hostile client can't skip the debounced
	// validate endpoint and submit a bad path directly).
	DataDir string

	// Theme is one of "dark" or "light". Anything else is rejected
	// with a 400-shaped error.
	Theme string

	// McpEnabled mirrors the wizard's MCP checkbox. Persisted into
	// cfg.MCP.Enabled (revision 2 W1 fix) so 08-09's listener sees
	// the user's choice at the next boot. False keeps the MCP
	// listener disabled (the default).
	McpEnabled bool

	// McpGrants is the optional seed list of folder grants the wizard
	// surfaced in the MCP step. Inserted directly into
	// mcp_write_grants AFTER migrations apply migration 004.
	McpGrants []SetupGrantSeed

	// DailyTemplate is the user's preferred template for new daily
	// notes (DESIGN.md §11 dailyNotes.template). Stored in
	// cfg.DailyNotes.Template; used by markdown.NewDailyNoteContent
	// when CreateTodayDailyNote is true.
	DailyTemplate string

	// CreateTodayDailyNote opt-in: when true, write
	// <DataDir>/notes/daily/<YYYY-MM-DD>.md with the template
	// substituted, so the user lands in the editor with a starting
	// note instead of an empty file tree.
	CreateTodayDailyNote bool
}

// SetupGrantSeed is the in-process form of a single grant row passed
// in by the wizard. Folder is a canonical relative path under notes/
// (DATA-11 NFC + lowercase) and Level is 1 or 2 (D-13 two-tier ACL).
// We don't re-validate either here: the ACL package (Plan 08-08)
// re-validates at MCP write time, and migration 004's CHECK constraint
// enforces level ∈ {1, 2}.
type SetupGrantSeed struct {
	Folder string
	Level  int
}

// RunSetup is the submit pipeline. Per D-10 the order is:
//
//  1. Theme value-check (cheap, no syscall).
//  2. ResolveDataDir: tilde-expand + absolute-path enforcement.
//  3. ValidateDataDir against the resolved path (final gate vs T-08-06).
//  4. vault.CreateVault: creates <DataDir>/.jasper/, config.json, app.db,
//     runs migrations, and registers the vault in app.json.
//  5. config.Save (legacy compatibility): also writes the old-style
//     <DataDir>/storage/config.json so pre-vault-model lifecycle code
//     that reads this file continues to work until fully removed.
//  6. Seed MCP grants in the new vault's app.db.
//  7. (optional) Write <DataDir>/notes/daily/<today>.md from the template.
//
// Plan 08-17b: steps 4+ now delegate vault initialization to
// vault.CreateVault (which handles .jasper/ + app.db + app.json). The
// legacy config.Save in step 5 is retained for backward compatibility
// with any code that still reads <DataDir>/storage/config.json; it will
// be removed when the old lifecycle path is fully retired.
//
// Errors are wrapped with a UI-friendly prefix; the handler maps the
// resulting error to a 500 with the wrapped message in the body.
//
// migrationsFS is the embedded migrations.FS plumbed through from
// app.New's caller (Server.migrationsFS).
func RunSetup(ctx context.Context, req SetupRequest, migrationsFS fs.FS) error {
	if req.Theme != "dark" && req.Theme != "light" {
		return fmt.Errorf("theme must be 'dark' or 'light'")
	}

	dataDir, refusalCode, refusalMsg := ResolveDataDir(req.DataDir)
	if refusalCode != "" {
		return fmt.Errorf("%s", refusalMsg)
	}

	if v := ValidateDataDir(dataDir); !v.Valid {
		return fmt.Errorf("%s", v.Message)
	}

	canonical, err := vault.Canonicalize(dataDir)
	if err != nil {
		return fmt.Errorf("canonicalize data dir: %w", err)
	}
	if _, err := vault.CreateVault(ctx, canonical, vault.CreateOpts{
		Theme:         req.Theme,
		DailyTemplate: req.DailyTemplate,
		MCPEnabled:    req.McpEnabled,
		MigrationsFS:  migrationsFS,
	}); err != nil {
		return fmt.Errorf("create vault: %w", err)
	}

	notesDir := filepath.Join(dataDir, "notes")
	if err := os.MkdirAll(notesDir, 0o700); err != nil {
		return fmt.Errorf("create notes dir: %w", err)
	}
	storageDir := filepath.Join(dataDir, "storage")
	if err := os.MkdirAll(storageDir, 0o700); err != nil {
		return fmt.Errorf("create storage dir: %w", err)
	}
	cfg := config.Defaults()
	cfg.Server.DataDir = dataDir
	cfg.Theme = req.Theme
	cfg.MCP.Enabled = req.McpEnabled
	if req.DailyTemplate != "" {
		cfg.DailyNotes.Template = req.DailyTemplate
	}
	if err := config.Save(dataDir, cfg); err != nil {
		return fmt.Errorf("save legacy config: %w", err)
	}

	dbPath := filepath.Join(dataDir, ".jasper", "app.db")
	if err := insertSeedGrants(ctx, dbPath, req.McpGrants); err != nil {
		return fmt.Errorf("seed grants: %w", err)
	}

	if req.CreateTodayDailyNote {
		today := time.Now().Format("2006-01-02")
		dailyDir := filepath.Join(notesDir, "daily")
		if err := os.MkdirAll(dailyDir, 0o755); err != nil {
			return fmt.Errorf("create daily dir: %w", err)
		}
		absPath := filepath.Join(dailyDir, today+".md")
		content := markdown.NewDailyNoteContent(today, cfg.DailyNotes.Template)
		if err := fsstore.AtomicWrite(absPath, content); err != nil {
			return fmt.Errorf("write today's daily note: %w", err)
		}
	}
	return nil
}

func insertSeedGrants(ctx context.Context, dbPath string, grants []SetupGrantSeed) error {
	if len(grants) == 0 {
		return nil
	}
	db, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer func() { _ = db.Close() }()
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping db: %w", err)
	}
	now := time.Now().Unix()
	stmt, err := db.PrepareContext(ctx,
		`INSERT INTO mcp_write_grants (folder_path, level, granted_at, granted_via)
		 VALUES (?, ?, ?, 'wizard')
		 ON CONFLICT(folder_path) DO UPDATE SET
		   level = excluded.level,
		   granted_at = excluded.granted_at,
		   granted_via = 'wizard'`)
	if err != nil {
		return fmt.Errorf("prepare insert: %w", err)
	}
	defer func() { _ = stmt.Close() }()
	for _, g := range grants {
		if _, err := stmt.ExecContext(ctx, g.Folder, g.Level, now); err != nil {
			return fmt.Errorf("insert grant %q: %w", g.Folder, err)
		}
	}
	return nil
}

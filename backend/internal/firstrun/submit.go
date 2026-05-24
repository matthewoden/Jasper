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
	// Step 1: validate theme up front (cheap, no syscall).
	if req.Theme != "dark" && req.Theme != "light" {
		return fmt.Errorf("theme must be 'dark' or 'light'")
	}

	// Step 2: resolve the data-dir.
	dataDir, refusalCode, refusalMsg := ResolveDataDir(req.DataDir)
	if refusalCode != "" {
		return fmt.Errorf("%s", refusalMsg)
	}

	// Step 3: re-validate the resolved data-dir.
	if v := ValidateDataDir(dataDir); !v.Valid {
		return fmt.Errorf("%s", v.Message)
	}

	// Step 4: delegate vault initialization to vault.CreateVault.
	// This creates <dataDir>/.jasper/{config.json,app.db}, runs migrations,
	// and registers the vault in app.json as the current_vault.
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

	// Step 5 (legacy compat): write <DataDir>/storage/config.json so
	// pre-vault-model lifecycle code that reads this file still finds it.
	// Also ensure the legacy directory layout exists so any downstream
	// code that assumes notes/ + storage/ subdirs doesn't race.
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

	// Step 6: seed MCP grants in the vault DB.
	dbPath := filepath.Join(dataDir, ".jasper", "app.db")
	if err := insertSeedGrants(ctx, dbPath, req.McpGrants); err != nil {
		return fmt.Errorf("seed grants: %w", err)
	}

	// Step 7 (optional): create today's daily note.
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

// insertSeedGrants opens a short-lived sql.DB on dbPath, upserts each
// grant row via ON CONFLICT(folder_path) DO UPDATE, and closes.
// Granted_via is hard-coded "wizard" so 08-08's telemetry surface can
// attribute the row to the first-run wizard rather than the
// tree-context-menu / dropdown-menu paths. now is captured once at the
// top so all rows share the same granted_at — useful for "show me
// everything seeded by the wizard" queries later.
//
// UAT-1 N8 (2026-05-19): the wizard's McpSection.handleAddFolder had no
// duplicate guard so a user could add the same folder twice before
// submitting. The previous plain INSERT hit SQLite extended error 2067
// (SQLITE_CONSTRAINT_UNIQUE) on the second row and failed the whole
// submit. Fixed via defense-in-depth at three layers:
//  1. Frontend McpSection.handleAddFolder: inline error on re-add.
//  2. Frontend SetupApp.handleSubmit: dedupGrantsByFolder before POST.
//  3. This function (layer 3): ON CONFLICT upsert — idempotent for
//     any caller that passes duplicate folder paths. Last-write-wins
//     on level. granted_via stays "wizard" on conflict (the row was
//     originally seeded by the wizard; conflicts only happen during
//     the same submit batch).
//
// Errors here are FATAL to the submit (caller wraps and returns 500).
// We could survive a partial insert by ignoring per-row failures, but
// the wizard's UX guarantees the user that the grants they picked WILL
// be in force after the redirect — a silent drop would violate that
// contract. The seed list is bounded by the wizard UI (a handful of
// folders at most), so the worst case is a few rows of work to retry.
//
// modernc.org/sqlite is the pure-Go driver locked in PROJECT — no CGo
// burden, single static binary on every target. The driver name is
// "sqlite" (NOT "sqlite3"); the file:<path> DSN suppresses the auto-
// created "$home/test.db" surprise.
//
// errors.Is + sql.ErrNoRows is not relevant here — we're upsert-only.
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

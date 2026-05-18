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
	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/markdown"
)

// SetupRequest is the in-process form of a wizard submit. The handler
// (api/setup_handler.go) translates the openapi-generated wire type
// into this struct before calling RunSetup, so RunSetup stays
// independent of the api package and is testable without the chi
// router.
type SetupRequest struct {
	// DataDir is the absolute path the user picked in Step 1 of the
	// wizard. RunSetup re-runs ValidateDataDir against this value as
	// a final gate (T-08-06 — a hostile client can't skip the
	// debounced validate endpoint and submit a bad path directly).
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
//  1. ValidateDataDir (final gate vs T-08-06 client bypass).
//  2. Theme value-check.
//  3. mkdir <DataDir>          0o700 (D-10 perm)
//     mkdir <DataDir>/notes    0o700
//     mkdir <DataDir>/storage  0o700 (config.Save's atomic write
//     writes into this dir so it MUST
//     exist before Save runs)
//  4. config.Save with Defaults() overlaid by:
//     - cfg.Server.DataDir = req.DataDir
//     - cfg.Theme          = req.Theme
//     - cfg.MCP.Enabled    = req.McpEnabled         (revision 2 W1)
//     - cfg.DailyNotes.Template = req.DailyTemplate
//     Server.Port (6683), MCP.Port (6684), MCP.Bind ("127.0.0.1")
//     are NOT overridable from the wizard (D-50 generalization —
//     port edits go through config.json directly).
//  5. Open sqlite.Pair on <DataDir>/storage/app.db, build a
//     migrate.Runner with the embedded migrations FS, run it, close
//     the pair. The Pair lifecycle is local to RunSetup — once the
//     migrations apply, the surrounding lifecycle.Run (after the
//     SPA's redirect-on-load cycle) opens its own long-lived Pair.
//  6. Seed MCP grants by opening a short-lived sql.DB and INSERT-ing
//     each (folder, level, now, 'wizard') row. The grant table is
//     created by migration 004 in step 5 so this must follow.
//  7. (optional) Write <notes>/daily/<today>.md from the template.
//
// Errors are wrapped with a UI-friendly prefix; the handler maps the
// resulting error to a 500 with the wrapped message in the body.
//
// migrationsFS is the embedded migrations.FS plumbed through from
// app.New's caller (Server.migrationsFS). Tests pass a small fstest.MapFS
// or os.DirFS pointed at backend/migrations.
func RunSetup(ctx context.Context, req SetupRequest, migrationsFS fs.FS) error {
	// Step 1: validate theme up front (cheap, no syscall).
	if req.Theme != "dark" && req.Theme != "light" {
		return fmt.Errorf("theme must be 'dark' or 'light'")
	}

	// Step 2: re-validate the data-dir. ValidateDataDir also mkdir-0700s
	// req.DataDir as part of the write probe, so when this returns
	// Valid: true the directory already exists with the right perms.
	if v := ValidateDataDir(req.DataDir); !v.Valid {
		return fmt.Errorf("%s", v.Message)
	}

	// Step 3: create <DataDir>/notes/ and <DataDir>/storage/ at 0o700.
	// ValidateDataDir created <DataDir> itself; we materialize the
	// canonical subdir layout here so the SPA + sqlite + config.Save
	// don't race against missing parents.
	notesDir := filepath.Join(req.DataDir, "notes")
	if err := os.MkdirAll(notesDir, 0o700); err != nil {
		return fmt.Errorf("create notes dir: %w", err)
	}
	storageDir := filepath.Join(req.DataDir, "storage")
	if err := os.MkdirAll(storageDir, 0o700); err != nil {
		return fmt.Errorf("create storage dir: %w", err)
	}

	// Step 4: build + save config from Defaults() with the wizard's
	// choices overlaid. Defaults() seeds Server.Port=6683, MCP.Port=6684,
	// MCP.Bind="127.0.0.1" — the wizard never overrides those (D-50).
	cfg := config.Defaults()
	cfg.Server.DataDir = req.DataDir
	cfg.Theme = req.Theme
	cfg.MCP.Enabled = req.McpEnabled // revision 2 W1 fix
	if req.DailyTemplate != "" {
		cfg.DailyNotes.Template = req.DailyTemplate
	}
	if err := config.Save(req.DataDir, cfg); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	// Step 5: run migrations against the new data-dir. We open a
	// short-lived sqlite.Pair + migrate.Runner scoped to this submit
	// call. The runner's Run method honors the three-path strategy
	// (DESIGN.md §4.4); on first run there's nothing to roll back so
	// the only failure modes are disk-full (returned as an error) and
	// unrecoverable schema state. Both surface as a 500 to the
	// wizard — the user can fix the underlying problem and resubmit
	// (RunSetup is idempotent for everything except the daily-note
	// step, which checks idempotency at AtomicWrite time).
	dbPath := filepath.Join(storageDir, "app.db")
	backupPath := dbPath + ".backup"
	logsPath := filepath.Join(storageDir, "logs", "jasper.log")
	if err := os.MkdirAll(filepath.Dir(logsPath), 0o700); err != nil {
		return fmt.Errorf("create logs dir: %w", err)
	}
	pair, err := sqlite.Open(ctx, dbPath)
	if err != nil {
		return fmt.Errorf("sqlite open: %w", err)
	}
	runner := migrate.NewRunner(migrate.RunnerOptions{
		DBPath:     dbPath,
		BackupPath: backupPath,
		LogsPath:   logsPath,
		Migrations: migrationsFS,
		Pair:       pair,
	})
	status, runErr := runner.Run(ctx)
	// Close the pair regardless of outcome — the lifecycle.Run that
	// follows the wizard's POST→302→SPA-reload cycle opens its own
	// pair, so we MUST release ours.
	if cerr := pair.Close(); cerr != nil && runErr == nil {
		runErr = fmt.Errorf("close sqlite pair: %w", cerr)
	}
	if runErr != nil {
		return fmt.Errorf("run migrations: %w", runErr)
	}
	if status.State == migrate.StateUnrecoverable {
		return fmt.Errorf("run migrations: unrecoverable schema state")
	}

	// Step 6: seed MCP grants directly via SQL. Migration 004 (Plan
	// 08-01) created the mcp_write_grants table; we INSERT the wizard's
	// seed rows with granted_via='wizard' so 08-08's UI can distinguish
	// wizard-seeded grants from tree-context-menu grants for the
	// telemetry / display surface.
	if err := insertSeedGrants(ctx, dbPath, req.McpGrants); err != nil {
		return fmt.Errorf("seed grants: %w", err)
	}

	// Step 7 (optional): create today's daily note. The wizard step
	// labeled "Create today's daily note?" passes
	// CreateTodayDailyNote=true when the checkbox is on. We mirror
	// api/daily.go's create branch: mkdir daily/ + AtomicWrite from
	// markdown.NewDailyNoteContent. We do NOT touch the SQLite index
	// here — the index lives in the indexer package and the next
	// lifecycle.Run incremental reconcile pass picks the file up
	// (DATA-09). Keeping the side effect tree-only also means
	// idempotent retries: AtomicWrite is overwrite-safe and the
	// content is deterministic for (date, template).
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

// insertSeedGrants opens a short-lived sql.DB on dbPath, INSERTs each
// grant row, and closes. Granted_via is hard-coded "wizard" so 08-08's
// telemetry surface can attribute the row to the first-run wizard
// rather than the tree-context-menu / dropdown-menu paths. now is
// captured once at the top so all rows share the same granted_at —
// useful for "show me everything seeded by the wizard" queries later.
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
// errors.Is + sql.ErrNoRows is not relevant here — we're INSERT-only.
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
		`INSERT INTO mcp_write_grants (folder_path, level, granted_at, granted_via) VALUES (?, ?, ?, 'wizard')`)
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

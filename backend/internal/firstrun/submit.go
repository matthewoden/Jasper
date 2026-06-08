package firstrun

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

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
	// surfaced in the MCP step. Queued to <canonical>/.jasper/seed_grants.json
	// at submit time; firstrun.ApplySeedGrants drains the queue on the
	// first server boot of the new vault (Phase 9 D-04).
	McpGrants []SetupGrantSeed

	// DailyTemplate is the user's preferred template for new daily
	// notes (DESIGN.md §11 dailyNotes.template). Stored in
	// cfg.DailyNotes.Template by vault.CreateVault; used here by
	// markdown.NewDailyNoteContent when CreateTodayDailyNote is true.
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
//  4. vault.Canonicalize: resolve symlinks + NFC-normalize ONCE; every
//     subsequent path computation uses the canonical value. This is the
//     single canonicalization invariant that mitigates the writer/reader
//     TOCTOU between writeSeedGrants and firstrun.ApplySeedGrants
//     (Phase 9 Plan 03b threat T-09-03b-06).
//  5. vault.CreateVault: creates <canonical>/.jasper/, config.json, and
//     registers the vault in app.json. Per Phase 9 D-04, CreateVault does
//     NOT open SQLite — the per-vault DB is opened by lifecycle on first
//     boot of the vault.
//  6. Queue MCP seed grants via writeSeedGrants to
//     <canonical>/.jasper/seed_grants.json — drained on first boot by
//     firstrun.ApplySeedGrants after migrations succeed.
//  7. (optional) Write <canonical>/notes/daily/<today>.md from the
//     template.
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

	notesDir := filepath.Join(canonical, "notes")
	if err := os.MkdirAll(notesDir, 0o700); err != nil {
		return fmt.Errorf("create notes dir: %w", err)
	}

	if err := writeSeedGrants(canonical, req.McpGrants); err != nil {
		return fmt.Errorf("write seed grants: %w", err)
	}

	if req.CreateTodayDailyNote {
		today := time.Now().Format("2006-01-02")
		dailyDir := filepath.Join(notesDir, "daily")
		if err := os.MkdirAll(dailyDir, 0o755); err != nil {
			return fmt.Errorf("create daily dir: %w", err)
		}
		absPath := filepath.Join(dailyDir, today+".md")
		content := markdown.NewDailyNoteContent(today, req.DailyTemplate)
		if err := fsstore.AtomicWrite(absPath, content); err != nil {
			return fmt.Errorf("write today's daily note: %w", err)
		}
	}
	return nil
}

// writeSeedGrants queues mcp_write_grants for first-boot apply. Writes
// <canonical>/.jasper/seed_grants.json atomically. firstrun.ApplySeedGrants
// drains the queue after migrations on first server boot of the vault.
//
// canonical MUST be the canonicalized vault root — see RunSetup's single
// canonicalization invariant. Mismatched canonicalization between writer
// and reader would silently drop the grants (handoff-TOCTOU; Plan 03b
// threat T-09-03b-06).
//
// Returns nil if len(grants) == 0 (no queue file written — the common
// path when the user did not seed any grants in the wizard).
//
// Parent <canonical>/.jasper/ is created by vault.CreateVault earlier in
// RunSetup, so fsstore.AtomicWrite's parent-exists precondition is met.
func writeSeedGrants(canonical string, grants []SetupGrantSeed) error {
	if len(grants) == 0 {
		return nil
	}
	raw, err := json.MarshalIndent(grants, "", "  ")
	if err != nil {
		return fmt.Errorf("writeSeedGrants: marshal: %w", err)
	}
	path := vault.SeedGrantsPath(canonical)
	if err := fsstore.AtomicWrite(path, raw); err != nil {
		return fmt.Errorf("writeSeedGrants: atomic-write %s: %w", path, err)
	}
	return nil
}

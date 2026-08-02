package firstrun

import (
	"context"
	"encoding/json"
	"fmt"
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
	// DataDir may be tilde-prefixed; RunSetup resolves it and re-validates the
	// result, so a client cannot skip the debounced validate endpoint.
	DataDir string

	// Theme is one of "dark" or "light". Anything else is rejected
	// with a 400-shaped error.
	Theme string

	// McpGrants is the optional seed list of folder grants the wizard
	// surfaced in the MCP step. Queued to <canonical>/.jasper/seed_grants.json
	// at submit time; firstrun.ApplySeedGrants drains the queue on the
	// first server boot of the new vault.
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

	// Accent is the wizard's Appearance accent selection
	// ("purple"|"sky"|"green"|"orange"). Empty falls back to the
	// config.Defaults() value at vault creation. Persisted into
	// cfg.Accent so the app opens with the user's chosen accent.
	Accent string

	// ReadingFont is the wizard's Appearance reading-font selection
	// ("sans"|"serif"). Empty falls back to config.Defaults(). Persisted
	// into cfg.ReadingFont.
	ReadingFont string
}

// SetupGrantSeed is the in-process form of a single grant row passed
// in by the wizard. Folder is a canonical relative path under notes/
// and Level is 1 or 2. Re-validation is deferred: the ACL package
// re-validates at MCP write time, and migration 004's CHECK constraint
// enforces level ∈ {1, 2}.
type SetupGrantSeed struct {
	Folder string
	Level  int
}

// RunSetup is the submit pipeline.
//
// The load-bearing invariant: canonicalize ONCE, then compute every subsequent
// path from that value. Canonicalizing twice lets writeSeedGrants and
// ApplySeedGrants disagree on the path and silently drop the grants.
func RunSetup(ctx context.Context, req SetupRequest) error {
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
		Accent:        req.Accent,
		ReadingFont:   req.ReadingFont,
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

// writeSeedGrants queues mcp_write_grants for ApplySeedGrants to drain on first
// boot. canonical MUST be the canonicalized vault root — if writer and reader
// canonicalize differently the grants are silently dropped.
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

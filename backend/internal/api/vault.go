package api

// vault.go — Plan 08-17b Task 1: /vault/* handler implementations.
//
// Five strict-server methods implementing the vault registry surface
// declared in api/openapi.yaml:
//
//   - GetVaultCurrent     GET  /api/v1/vault/current
//   - GetVaultRecent      GET  /api/v1/vault/recent
//   - PostVaultOpen       POST /api/v1/vault/open
//   - PostVaultCreate     POST /api/v1/vault/create
//   - PostVaultForget     POST /api/v1/vault/forget
//
// All handlers read/write via vault.LoadAppJSON + vault.SaveAppJSON —
// no direct disk I/O except in PostVaultCreate's mkdir + migrations step.
// None panics on missing app.json (loader auto-creates).

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/migrations"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

// BootBanner is a process-level string populated by lifecycle.Run when a
// V13/V14 condition is detected at boot. GetVaultRecent reads this and
// includes it in the response so the picker UI can render the banner.
// Cleared on successful POST /vault/open or /vault/create.
//
// Exported so lifecycle_vault.go (Task 2) can write to it and package-level
// tests can assert on it.
var BootBanner string

// GetVaultCurrent returns the currently open vault or null when no vault is open.
//
// Wire: GET /api/v1/vault/current → 200 { vault: RecentVaultEntry | null }
//
//nolint:revive // generated interface method name
func (s *Server) GetVaultCurrent(
	_ context.Context,
	_ GetVaultCurrentRequestObject,
) (GetVaultCurrentResponseObject, error) {
	appJSONPath, err := vault.AppJSONPath()
	if err != nil {
		return nil, fmt.Errorf("GetVaultCurrent: resolve app home: %w", err)
	}
	state, err := vault.LoadAppJSON(appJSONPath)
	if err != nil {
		return nil, fmt.Errorf("GetVaultCurrent: load app.json: %w", err)
	}

	if state.CurrentVault == "" {
		// No vault open — return {vault: null}.
		return GetVaultCurrent200JSONResponse{Vault: nil}, nil
	}

	// Find the matching entry in recent_vaults.
	for _, e := range state.RecentVaults {
		if e.Path == state.CurrentVault {
			entry := toWireRecentVaultEntry(e)
			return GetVaultCurrent200JSONResponse{Vault: &entry}, nil
		}
	}

	// current_vault set but not in recent_vaults — shouldn't happen,
	// but be safe: return null so the picker renders.
	return GetVaultCurrent200JSONResponse{Vault: nil}, nil
}

// GetVaultRecent returns the recent_vaults list (newest-first) plus the
// optional V13/V14 boot banner.
//
// Wire: GET /api/v1/vault/recent → 200 { vaults: [...], banner: string }
//
//nolint:revive // generated interface method name
func (s *Server) GetVaultRecent(
	_ context.Context,
	_ GetVaultRecentRequestObject,
) (GetVaultRecentResponseObject, error) {
	appJSONPath, err := vault.AppJSONPath()
	if err != nil {
		return nil, fmt.Errorf("GetVaultRecent: resolve app home: %w", err)
	}
	state, err := vault.LoadAppJSON(appJSONPath)
	if err != nil {
		return nil, fmt.Errorf("GetVaultRecent: load app.json: %w", err)
	}

	wireVaults := make([]RecentVaultEntry, len(state.RecentVaults))
	for i, e := range state.RecentVaults {
		wireVaults[i] = toWireRecentVaultEntry(e)
	}

	return GetVaultRecent200JSONResponse{
		Vaults: wireVaults,
		Banner: BootBanner,
	}, nil
}

// PostVaultOpen opens an existing vault folder. The folder must already
// contain a .jasper/ directory. Validates the path (abs, ASCII+NFC),
// updates app.json via vault.TouchOpened, and clears BootBanner.
//
// Wire: POST /api/v1/vault/open → 200 RecentVaultEntry | 400 | 409
//
//nolint:revive // generated interface method name
func (s *Server) PostVaultOpen(
	_ context.Context,
	req PostVaultOpenRequestObject,
) (PostVaultOpenResponseObject, error) {
	if req.Body == nil {
		return PostVaultOpen400JSONResponse(newError("invalid_request", "request body required")), nil
	}

	rawPath := req.Body.Path
	if !filepath.IsAbs(rawPath) {
		return PostVaultOpen400JSONResponse(newError("invalid_path", "path must be absolute")), nil
	}

	if err := validateVaultPath(rawPath); err != nil {
		return PostVaultOpen400JSONResponse(newError("invalid_path", err.Error())), nil
	}

	canonical, err := vault.Canonicalize(rawPath)
	if err != nil {
		return PostVaultOpen400JSONResponse(newError("invalid_path", err.Error())), nil
	}

	// Verify .jasper/ exists (V14 invariant — missing .jasper is an error, not auto-rebuild).
	jasperDir := filepath.Join(canonical, ".jasper")
	info, statErr := os.Stat(jasperDir)
	if statErr != nil || !info.IsDir() {
		return PostVaultOpen400JSONResponse(newError("missing_jasper_dir",
			"the folder exists but does not contain a .jasper/ directory; create a vault here first")), nil
	}

	// Update app.json: register/refresh the vault entry.
	appJSONPath, err := vault.AppJSONPath()
	if err != nil {
		return nil, fmt.Errorf("PostVaultOpen: resolve app home: %w", err)
	}
	state, err := vault.LoadAppJSON(appJSONPath)
	if err != nil {
		return nil, fmt.Errorf("PostVaultOpen: load app.json: %w", err)
	}

	// Determine display name from existing entry if present.
	displayName := filepath.Base(canonical)
	for _, e := range state.RecentVaults {
		if e.Path == canonical {
			displayName = e.DisplayName
			break
		}
	}

	vault.TouchOpened(state, canonical, displayName)
	if err := vault.SaveAppJSON(appJSONPath, state); err != nil {
		return nil, fmt.Errorf("PostVaultOpen: save app.json: %w", err)
	}
	BootBanner = "" // V13/V14 banner cleared on successful open.

	// Find the entry we just touched.
	for _, e := range state.RecentVaults {
		if e.Path == canonical {
			wire := toWireRecentVaultEntry(e)
			return PostVaultOpen200JSONResponse(wire), nil
		}
	}
	// Shouldn't be reachable — TouchOpened guarantees the entry is in the list.
	return nil, fmt.Errorf("PostVaultOpen: entry not found after TouchOpened")
}

// PostVaultCreate creates a new Jasper vault inside the chosen folder.
//
// Validation pipeline (T-17b-01 + T-17b-02):
//  1. abs path
//  2. ASCII+NFC check (V-PARK-1 carry-forward)
//  3. parent directory must exist
//  4. .jasper/ must NOT already exist (already-a-vault check)
//  5. nested-vault detection (upstream-walk for ancestor .jasper/)
//
// If validation passes: mkdir .jasper/ 0700 → write per-vault config.json
// → open DB + run migrations → register in app.json via TouchOpened.
//
// Wire: POST /api/v1/vault/create → 200 RecentVaultEntry | 400 | 409
//
//nolint:revive // generated interface method name
func (s *Server) PostVaultCreate(
	ctx context.Context,
	req PostVaultCreateRequestObject,
) (PostVaultCreateResponseObject, error) {
	if req.Body == nil {
		return PostVaultCreate400JSONResponse(newError("invalid_request", "request body required")), nil
	}

	rawPath := req.Body.Path
	if !filepath.IsAbs(rawPath) {
		return PostVaultCreate400JSONResponse(newError("invalid_path", "path must be absolute")), nil
	}

	if err := validateVaultPath(rawPath); err != nil {
		return PostVaultCreate400JSONResponse(newError("invalid_path", err.Error())), nil
	}

	canonical, err := vault.Canonicalize(rawPath)
	if err != nil {
		return PostVaultCreate400JSONResponse(newError("invalid_path", err.Error())), nil
	}

	// Parent directory must exist.
	parent := filepath.Dir(canonical)
	if _, parentErr := os.Stat(parent); os.IsNotExist(parentErr) {
		return PostVaultCreate400JSONResponse(newError("parent_missing",
			"the parent folder doesn't exist; create it first")), nil
	}

	// Already a vault?
	jasperDir := filepath.Join(canonical, ".jasper")
	if _, jasperErr := os.Stat(jasperDir); jasperErr == nil {
		return PostVaultCreate400JSONResponse(newError("already_a_vault",
			"this folder already contains a .jasper/ directory; open it instead of creating")), nil
	}

	// Nested-vault detection (T-17b-02): walk ancestors for any .jasper/ directory.
	cur := canonical
	for {
		anc := filepath.Dir(cur)
		if anc == cur {
			break
		}
		if _, statErr := os.Stat(filepath.Join(anc, ".jasper")); statErr == nil {
			return PostVaultCreate400JSONResponse(newError("nested_vault",
				"path is inside an existing Jasper vault: "+anc)), nil
		}
		cur = anc
	}

	// Determine display name and optional per-vault settings.
	displayName := filepath.Base(canonical)
	if req.Body.DisplayName != nil && *req.Body.DisplayName != "" {
		displayName = *req.Body.DisplayName
	}
	theme := "dark"
	if req.Body.Theme != nil {
		theme = string(*req.Body.Theme)
	}
	dailyTemplate := ""
	if req.Body.DailyTemplate != nil {
		dailyTemplate = *req.Body.DailyTemplate
	}
	mcpEnabled := false
	if req.Body.McpEnabled != nil {
		mcpEnabled = *req.Body.McpEnabled
	}

	// Create .jasper/ with 0700.
	if mkdirErr := os.MkdirAll(jasperDir, 0o700); mkdirErr != nil {
		return PostVaultCreate400JSONResponse(newError("create_failed",
			"failed to create .jasper/ directory: "+mkdirErr.Error())), nil
	}

	// Write minimal per-vault config.json.
	cfgPath := filepath.Join(jasperDir, "config.json")
	now := time.Now().UTC()
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
		CreatedAt:   now.Format(time.RFC3339),
		Theme:       theme,
		DailyNotes:  dailyNotesCfg{Template: dailyTemplate},
		MCP:         mcpCfg{Enabled: mcpEnabled},
	}
	cfgBytes, jsonErr := json.MarshalIndent(cfgData, "", "  ")
	if jsonErr != nil {
		return nil, fmt.Errorf("PostVaultCreate: marshal config: %w", jsonErr)
	}
	if writeErr := fsstore.AtomicWrite(cfgPath, cfgBytes); writeErr != nil {
		return nil, fmt.Errorf("PostVaultCreate: write config.json: %w", writeErr)
	}

	// Open DB and run migrations.
	dbPath := filepath.Join(jasperDir, "app.db")
	backupPath := dbPath + ".backup"
	logsDir := filepath.Join(jasperDir, "logs")
	if logsErr := os.MkdirAll(logsDir, 0o700); logsErr != nil {
		return nil, fmt.Errorf("PostVaultCreate: ensure logs dir: %w", logsErr)
	}
	logsPath := filepath.Join(logsDir, "jasper.log")

	pair, sqlErr := sqlite.Open(ctx, dbPath)
	if sqlErr != nil {
		return nil, fmt.Errorf("PostVaultCreate: sqlite open: %w", sqlErr)
	}

	migrFS := vaultMigrationsFS(s)
	runner := migrate.NewRunner(migrate.RunnerOptions{
		DBPath:     dbPath,
		BackupPath: backupPath,
		LogsPath:   logsPath,
		Migrations: migrFS,
		Pair:       pair,
	})
	status, runErr := runner.Run(ctx)
	if cerr := pair.Close(); cerr != nil && runErr == nil {
		runErr = cerr
	}
	if runErr != nil {
		return nil, fmt.Errorf("PostVaultCreate: run migrations: %w", runErr)
	}
	if status.State == migrate.StateUnrecoverable {
		return nil, fmt.Errorf("PostVaultCreate: unrecoverable migration state")
	}

	// Register in app.json.
	appJSONPath, appErr := vault.AppJSONPath()
	if appErr != nil {
		return nil, fmt.Errorf("PostVaultCreate: resolve app home: %w", appErr)
	}
	appState, loadErr := vault.LoadAppJSON(appJSONPath)
	if loadErr != nil {
		return nil, fmt.Errorf("PostVaultCreate: load app.json: %w", loadErr)
	}
	vault.TouchOpened(appState, canonical, displayName)
	if saveErr := vault.SaveAppJSON(appJSONPath, appState); saveErr != nil {
		return nil, fmt.Errorf("PostVaultCreate: save app.json: %w", saveErr)
	}
	BootBanner = ""

	for _, e := range appState.RecentVaults {
		if e.Path == canonical {
			wire := toWireRecentVaultEntry(e)
			return PostVaultCreate200JSONResponse(wire), nil
		}
	}
	return nil, fmt.Errorf("PostVaultCreate: entry not found after TouchOpened")
}

// PostVaultForget removes a vault entry from recent_vaults. Idempotent.
//
// Wire: POST /api/v1/vault/forget → 200
//
//nolint:revive // generated interface method name
func (s *Server) PostVaultForget(
	_ context.Context,
	req PostVaultForgetRequestObject,
) (PostVaultForgetResponseObject, error) {
	if req.Body == nil {
		return PostVaultForget200Response{}, nil // idempotent — nothing to do
	}

	rawPath := req.Body.Path
	// Canonicalize if possible; if it fails just use the raw path so
	// the forget is still attempted (the entry was registered with a
	// canonical path, so a non-canonical input won't match — that's
	// the idempotent "wasn't in the list" case).
	canonical := rawPath
	if filepath.IsAbs(rawPath) {
		if c, canErr := vault.Canonicalize(rawPath); canErr == nil {
			canonical = c
		}
	}

	appJSONPath, err := vault.AppJSONPath()
	if err != nil {
		return nil, fmt.Errorf("PostVaultForget: resolve app home: %w", err)
	}
	state, err := vault.LoadAppJSON(appJSONPath)
	if err != nil {
		return nil, fmt.Errorf("PostVaultForget: load app.json: %w", err)
	}
	vault.Forget(state, canonical)
	if err := vault.SaveAppJSON(appJSONPath, state); err != nil {
		return nil, fmt.Errorf("PostVaultForget: save app.json: %w", err)
	}
	return PostVaultForget200Response{}, nil
}

// --- helpers ---

// toWireRecentVaultEntry maps a vault.RecentVaultEntry to the generated
// api.RecentVaultEntry wire type.
func toWireRecentVaultEntry(e vault.RecentVaultEntry) RecentVaultEntry {
	return RecentVaultEntry{
		Path:         e.Path,
		DisplayName:  e.DisplayName,
		LastOpenedAt: e.LastOpenedAt,
		CreatedAt:    e.CreatedAt,
		Missing:      e.Missing,
	}
}

// validateVaultPath applies the ASCII+NFC constraint (V-PARK-1) shared
// between PostVaultOpen and PostVaultCreate. Path must already be absolute
// (caller checks this before calling validateVaultPath).
func validateVaultPath(p string) error {
	if !norm.NFC.IsNormalString(p) {
		return fmt.Errorf("path must be NFC-normalized")
	}
	for _, r := range p {
		if r > unicode.MaxASCII {
			return fmt.Errorf("path must contain only ASCII characters (no emojis or accented characters)")
		}
	}
	return nil
}

// vaultMigrationsFS returns the migrations fs.FS to use for vault creation.
// Production: the Server's migrationsFS (wired by app.New/lifecycle.Run),
// falling back to the embedded migrations.FS. Test override: migrationsFS
// is wired via SetMigrationsFS (same pattern as firstrun.RunSetup).
func vaultMigrationsFS(s *Server) fs.FS {
	if s.migrationsFS != nil {
		return s.migrationsFS
	}
	return migrations.FS
}

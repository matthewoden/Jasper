package api

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

// VaultSwitcher is the interface the /vault/switch handler uses to initiate
// a hot-swap. Implemented by *app.App; kept as an interface here to avoid
// an import cycle (api imports app would be circular since app imports api).
//
// nil-safe: PostVaultSwitch returns 400 "no_vault_open" when switcher is nil
// (i.e., the server is in no-vault mode and there is nothing to switch from).
type VaultSwitcher interface {
	// SwitchVault transitions the running server from the current vault to
	// targetPath. Returns ErrSwitchInProgress on contention.
	SwitchVault(ctx context.Context, targetPath string) (vault.RecentVaultEntry, error)

	// CurrentVaultPath returns the canonical path of the currently open
	// vault, or "" when none is open.
	CurrentVaultPath() string
}

const switchInProgressMsg = "vault switch already in progress"

// SetVaultSwitcher wires the hot-swap entry point into the Server so the
// /vault/switch handler can call SwitchVault. Additive setter pattern.
func (s *Server) SetVaultSwitcher(vs VaultSwitcher) {
	s.vaultSwitcher = vs
}

// VaultOpener is the interface PostVaultCreate + PostVaultOpen use to
// transition the running server from no-vault mode (picker shell only) to
// vault-open mode (full stack). Implemented by *app.App.
//
// Distinct from VaultSwitcher: SwitchVault assumes a vault is already open
// and runs the teardown protocol; OpenVault assumes no vault is open and
// brings up per-vault subsystems alongside the existing listener.
//
// nil-safe: when the opener isn't wired, handlers fall back to best-effort —
// write to disk and update app.json, skip the in-process transition. The next
// process restart picks it up.
type VaultOpener interface {
	// OpenVault transitions a no-vault App to an open-vault App for the
	// vault at absCanonical. Updates app.json and brings up the per-vault
	// subsystems (DB, indexer, MCP, etc.). Returns an error if a vault is
	// already open (use SwitchVault for vault → vault transitions) or
	// another concurrent open/switch is in progress.
	OpenVault(ctx context.Context, absCanonical string) error
}

// SetVaultOpener wires the no-vault → open transition entry point into
// the Server. PostVaultCreate + PostVaultOpen call it after their disk
// preparation completes so the running listener picks up the new vault
// without a process restart.
func (s *Server) SetVaultOpener(vo VaultOpener) {
	s.vaultOpener = vo
}

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

	target := state.CurrentVault

	// When --vault override is active (E2E, CI, dev) the vault is open but
	// app.json has no current_vault entry. Fall back to the live path.
	if target == "" && s.vaultSwitcher != nil {
		if live := s.vaultSwitcher.CurrentVaultPath(); live != "" {
			target = live
		}
	}

	if target == "" {
		return GetVaultCurrent200JSONResponse{Vault: nil}, nil
	}

	for _, e := range state.RecentVaults {
		if e.Path == target {
			entry := toWireRecentVaultEntry(e)
			return GetVaultCurrent200JSONResponse{Vault: &entry}, nil
		}
	}

	// Vault is open (via --vault override) but not in recent_vaults yet —
	// synthesize a minimal entry so the frontend renders the main UI.
	if target != "" {
		entry := RecentVaultEntry{
			Path:        target,
			DisplayName: filepath.Base(target),
		}
		return GetVaultCurrent200JSONResponse{Vault: &entry}, nil
	}

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
	ctx context.Context,
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

	if rawAppHome, appHomeErr := vault.AppHomePath(); appHomeErr == nil {
		appHomeCanonical, cErr := vault.Canonicalize(rawAppHome)
		if cErr != nil {
			appHomeCanonical = rawAppHome
		}
		candidateJasper := filepath.Join(canonical, vault.SubdirName)
		if candJasperCanon, cErr := vault.Canonicalize(candidateJasper); cErr == nil &&
			candJasperCanon == appHomeCanonical {
			return PostVaultOpen400JSONResponse(newError("missing_jasper_dir",
				"this folder's .jasper/ is the Jasper app registry, not a vault — create a vault in a different folder")), nil
		}
	}

	jasperDir := filepath.Join(canonical, vault.SubdirName)
	info, statErr := os.Stat(jasperDir)
	if statErr != nil || !info.IsDir() {
		return PostVaultOpen400JSONResponse(newError("missing_jasper_dir",
			"the folder exists but does not contain a .jasper/ directory; create a vault here first")), nil
	}

	appJSONPath, err := vault.AppJSONPath()
	if err != nil {
		return nil, fmt.Errorf("PostVaultOpen: resolve app home: %w", err)
	}
	state, err := vault.LoadAppJSON(appJSONPath)
	if err != nil {
		return nil, fmt.Errorf("PostVaultOpen: load app.json: %w", err)
	}

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
	BootBanner = ""

	if s.vaultOpener != nil {
		if err := s.vaultOpener.OpenVault(ctx, canonical); err != nil {
			return nil, fmt.Errorf("PostVaultOpen: open in place: %w", err)
		}
	}

	for _, e := range state.RecentVaults {
		if e.Path == canonical {
			wire := toWireRecentVaultEntry(e)
			return PostVaultOpen200JSONResponse(wire), nil
		}
	}

	return nil, fmt.Errorf("PostVaultOpen: entry not found after TouchOpened")
}

// PostVaultCreate creates a new Jasper vault inside the chosen folder.
//
// Validation pipeline:
//  1. abs path
//  2. ASCII+NFC check
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

	appHomeCanonical := ""
	if raw, err := vault.AppHomePath(); err == nil {
		if c, cErr := vault.Canonicalize(raw); cErr == nil {
			appHomeCanonical = c
		} else {
			appHomeCanonical = raw
		}
	}

	if appHomeCanonical != "" && canonical == appHomeCanonical {
		return PostVaultCreate400JSONResponse(newError("invalid_path",
			"cannot create a vault at the Jasper app home directory ("+appHomeCanonical+
				"); choose a different folder")), nil
	}

	parent := filepath.Dir(canonical)
	if _, parentErr := os.Stat(parent); os.IsNotExist(parentErr) {
		return PostVaultCreate400JSONResponse(newError("parent_missing",
			"the parent folder doesn't exist; create it first")), nil
	}

	jasperDir := filepath.Join(canonical, vault.SubdirName)
	if _, jasperErr := os.Stat(jasperDir); jasperErr == nil {
		if jasperDirCanon, cErr := vault.Canonicalize(jasperDir); cErr != nil ||
			jasperDirCanon != appHomeCanonical {
			return PostVaultCreate400JSONResponse(newError("already_a_vault",
				"this folder already contains a .jasper/ directory; open it instead of creating")), nil
		}
	}

	cur := canonical
	for {
		anc := filepath.Dir(cur)
		if anc == cur {
			break
		}
		ancJasper := filepath.Join(anc, vault.SubdirName)
		if _, statErr := os.Stat(ancJasper); statErr == nil {
			ancJasperCanon, cErr := vault.Canonicalize(ancJasper)
			if cErr != nil || ancJasperCanon != appHomeCanonical {
				return PostVaultCreate400JSONResponse(newError("nested_vault",
					"path is inside an existing Jasper vault: "+anc)), nil
			}
		}
		cur = anc
	}

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

	appState, createErr := vault.CreateVault(ctx, canonical, vault.CreateOpts{
		DisplayName:   displayName,
		Theme:         theme,
		DailyTemplate: dailyTemplate,
		MCPEnabled:    mcpEnabled,
	})
	if createErr != nil {
		return nil, fmt.Errorf("PostVaultCreate: %w", createErr)
	}
	BootBanner = ""

	if s.vaultOpener != nil {
		if err := s.vaultOpener.OpenVault(ctx, canonical); err != nil {
			return nil, fmt.Errorf("PostVaultCreate: open in place: %w", err)
		}
	}

	for _, e := range appState.RecentVaults {
		if e.Path == canonical {
			wire := toWireRecentVaultEntry(e)
			return PostVaultCreate200JSONResponse(wire), nil
		}
	}
	return nil, fmt.Errorf("PostVaultCreate: entry not found after CreateVault")
}

// PostVaultSwitch initiates a hot-swap to the given target vault path.
//
// Returns 200 with the new vault entry on success.
// Returns 400 when the target path is invalid or missing .jasper/.
// Returns 409 (vault_switch_in_progress) when a switch is already in progress.
//
// Wire: POST /api/v1/vault/switch
//
//nolint:revive // generated interface method name
func (s *Server) PostVaultSwitch(
	ctx context.Context,
	req PostVaultSwitchRequestObject,
) (PostVaultSwitchResponseObject, error) {
	if req.Body == nil {
		return PostVaultSwitch400JSONResponse(newError("invalid_request", "request body required")), nil
	}

	if s.vaultSwitcher == nil {
		return PostVaultSwitch400JSONResponse(newError("no_vault_open",
			"no vault is currently open; use /vault/open to open a vault first")), nil
	}

	rawPath := req.Body.Path
	if !filepath.IsAbs(rawPath) {
		return PostVaultSwitch400JSONResponse(newError("invalid_path", "path must be absolute")), nil
	}
	if err := validateVaultPath(rawPath); err != nil {
		return PostVaultSwitch400JSONResponse(newError("invalid_path", err.Error())), nil
	}

	entry, err := s.vaultSwitcher.SwitchVault(ctx, rawPath)
	if err != nil {
		if err.Error() == switchInProgressMsg {
			currentTarget := s.vaultSwitcher.CurrentVaultPath()
			return PostVaultSwitch409JSONResponse{
				Error:         VaultSwitchInProgress,
				CurrentTarget: currentTarget,
			}, nil
		}
		return PostVaultSwitch400JSONResponse(newError("switch_failed", err.Error())), nil
	}

	return PostVaultSwitch200JSONResponse(toWireRecentVaultEntry(entry)), nil
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
		return PostVaultForget200Response{}, nil
	}

	rawPath := req.Body.Path

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

func toWireRecentVaultEntry(e vault.RecentVaultEntry) RecentVaultEntry {
	return RecentVaultEntry{
		Path:         e.Path,
		DisplayName:  e.DisplayName,
		LastOpenedAt: e.LastOpenedAt,
		CreatedAt:    e.CreatedAt,
		Missing:      e.Missing,
	}
}

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

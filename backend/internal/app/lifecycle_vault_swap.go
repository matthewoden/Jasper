package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/matthewoden/jasper/backend/internal/vault"
	"github.com/matthewoden/jasper/backend/internal/wshub"
)

// ErrSwitchInProgress is returned by SwitchVault when a switch is already
// in progress. The HTTP handler maps this to 409 + vault_switch_in_progress.
var ErrSwitchInProgress = errors.New("vault switch already in progress")

// SwitchVault hot-swaps from the currently open vault to targetPath.
//
// V5: TryLock-based single-flight enforcement. Returns ErrSwitchInProgress
// immediately on contention; no queuing.
//
// V6: drains inFlightWrites with a 2-second cap before teardown. Writers
// that complete BEFORE the drain window are safely committed in the old vault.
// Writers that are still in-flight when the 2s cap fires will hit a closed DB
// and surface an error to their callers; this is logged as a Warn and is an
// accepted trade-off (T-17d-06).
//
// The ctx parameter governs the lifetime of the NEW vault's per-vault
// subsystems (DB, indexer, MCP, etc.). Cancel it to shut down the new vault.
func (a *App) SwitchVault(ctx context.Context, targetPath string) (vault.RecentVaultEntry, error) {
	if !a.swapMu.TryLock() {
		return vault.RecentVaultEntry{}, ErrSwitchInProgress
	}
	defer a.swapMu.Unlock()

	if !filepath.IsAbs(targetPath) {
		return vault.RecentVaultEntry{}, fmt.Errorf("target vault path must be absolute: %q", targetPath)
	}
	canonical, err := vault.Canonicalize(targetPath)
	if err != nil {
		return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: canonicalize target: %w", err)
	}
	jasperDir := filepath.Join(canonical, vault.SubdirName)
	info, statErr := os.Stat(jasperDir)
	if statErr != nil || !info.IsDir() {
		return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: target vault missing .jasper/ directory: %s", canonical)
	}

	appJSONPath, appJSONErr := vault.AppJSONPath()
	if appJSONErr != nil {
		return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: resolve app home: %w", appJSONErr)
	}
	state, loadErr := vault.LoadAppJSON(appJSONPath)
	if loadErr != nil {
		return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: load app.json: %w", loadErr)
	}
	displayName := filepath.Base(canonical)
	for _, e := range state.RecentVaults {
		if e.Path == canonical {
			displayName = e.DisplayName
			break
		}
	}

	a.mu.RLock()
	oldHub := a.hub
	a.mu.RUnlock()

	if oldHub != nil {
		oldHub.Broadcast(wshub.EventVaultSwitching, map[string]string{
			"target_path":         canonical,
			"target_display_name": displayName,
		}, "")
	}

	drainCh := make(chan struct{})
	go func() { a.inFlightWrites.Wait(); close(drainCh) }()
	select {
	case <-drainCh:

	case <-time.After(2 * time.Second):

		a.cfg.Logger.Warn("SwitchVault: drain timeout after 2s; tearing down with possibly-pending writes")
	}

	if tearErr := a.tearDownPerVaultSubsystems(); tearErr != nil {
		return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: teardown: %w", tearErr)
	}

	a.cfg.DataDir = canonical
	if bootErr := a.initVaultSubsystemsOnly(ctx); bootErr != nil {
		return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: open new vault: %w", bootErr)
	}

	state, loadErr = vault.LoadAppJSON(appJSONPath)
	if loadErr != nil {
		return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: reload app.json after boot: %w", loadErr)
	}
	vault.TouchOpened(state, canonical, displayName)
	if saveErr := vault.SaveAppJSON(appJSONPath, state); saveErr != nil {
		return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: persist app.json after switch: %w", saveErr)
	}
	a.setCurrentVaultPath(canonical)

	if oldHub != nil {
		oldHub.Broadcast(wshub.EventVaultSwitched, map[string]string{
			"path":         canonical,
			"display_name": displayName,
		}, "")
	}

	for _, e := range state.RecentVaults {
		if e.Path == canonical {
			return e, nil
		}
	}
	return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: internal: new entry missing after TouchOpened (path=%s)", canonical)
}

func (a *App) tearDownPerVaultSubsystems() error {
	if a.pair != nil {
		if err := a.pair.Close(); err != nil {
			a.cfg.Logger.Warn("teardown: pair.Close error (continuing)", "err", err)
		}
		a.pair = nil
	}

	a.indexer = nil

	if a.mcpShutdown != nil {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := a.mcpShutdown(shutdownCtx); err != nil {
			a.cfg.Logger.Warn("teardown: MCP shutdown error (continuing)", "err", err)
		}
		a.mcpServer = nil
		a.mcpShutdown = nil
	}

	if a.fileLogCloser != nil {
		if err := a.fileLogCloser.Close(); err != nil {
			a.cfg.Logger.Warn("teardown: fileLogCloser.Close error (continuing)", "err", err)
		}
		a.fileLogCloser = nil
	}

	return nil
}

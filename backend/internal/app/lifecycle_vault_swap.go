package app

// lifecycle_vault_swap.go — Plan 08-17d: hot-swap primitive (ADR-001 §4).
//
// SwitchVault atomically transitions the running server from vault A to
// vault B without restarting the process. The operation:
//
//  1. Acquires swapMu via TryLock (V5: concurrent 409 enforcement).
//  2. Validates the target vault path.
//  3. Broadcasts vault.switching so the SPA mounts the overlay (V4).
//  4. Drains in-flight writes from SPA + MCP with a 2-second cap (V6).
//  5. Tears down per-vault subsystems in ADR §3 order (tearDownPerVaultSubsystems).
//  6. Opens the new vault: bootPerVaultSubsystems(ctx, newPath).
//  7. Updates app.json via vault.TouchOpened + SaveAppJSON.
//  8. Broadcasts vault.switched so the SPA reloads (V4).
//
// Concurrent switch attempts return ErrSwitchInProgress immediately (V5).
// The 2-second drain cap (V6) ensures SwitchVault does not block indefinitely
// when a writer hangs (T-17d-06: accepted residual risk, logged as Warn).
//
// Teardown ORDER per ADR-001 §3 + INVESTIGATION.md:
//  1. Close sqlite.Pair (pair.Close)
//  2. Shutdown MCP listener (mcpShutdown)
//  3. Close file logger (fileLogCloser.Close)
//  4. Clear indexer reference (no background goroutine — closing pair stops SQL)
//  5. DO NOT close wshub.Hub — SPA needs vault.switched on the same WS connection

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
	// V5: single in-flight switch.
	if !a.swapMu.TryLock() {
		return vault.RecentVaultEntry{}, ErrSwitchInProgress
	}
	defer a.swapMu.Unlock()

	// Validate + canonicalize the target.
	if !filepath.IsAbs(targetPath) {
		return vault.RecentVaultEntry{}, fmt.Errorf("target vault path must be absolute: %q", targetPath)
	}
	canonical, err := vault.Canonicalize(targetPath)
	if err != nil {
		return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: canonicalize target: %w", err)
	}
	jasperDir := filepath.Join(canonical, ".jasper")
	info, statErr := os.Stat(jasperDir)
	if statErr != nil || !info.IsDir() {
		return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: target vault missing .jasper/ directory: %s", canonical)
	}

	// Resolve display name for the vault.switching payload.
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

	// V4 + V6: save the old hub BEFORE teardown — existing SPA WS connections
	// are on this hub and must receive vault.switched so they reload.
	a.mu.RLock()
	oldHub := a.hub
	a.mu.RUnlock()

	// Broadcast vault.switching on the OLD hub so the SPA mounts the overlay.
	// The overlay is mounted before writes are drained (V4).
	if oldHub != nil {
		oldHub.Broadcast(wshub.EventVaultSwitching, map[string]string{
			"target_path":         canonical,
			"target_display_name": displayName,
		}, "")
	}

	// V6: drain pending writes (SPA + MCP) with 2-second cap.
	drainCh := make(chan struct{})
	go func() { a.inFlightWrites.Wait(); close(drainCh) }()
	select {
	case <-drainCh:
		// All in-flight writes drained cleanly.
	case <-time.After(2 * time.Second):
		// V6 cap hit: proceed. The drain timeout fires only when a writer is
		// taking > 2s (unusual for local file I/O). The writer will hit
		// a closed DB after teardown and return an error to its caller.
		a.cfg.Logger.Warn("SwitchVault: drain timeout after 2s; tearing down with possibly-pending writes")
	}

	// V6 teardown ORDER (per ADR §3 + INVESTIGATION.md).
	if tearErr := a.tearDownPerVaultSubsystems(); tearErr != nil {
		return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: teardown: %w", tearErr)
	}

	// Bring up the new vault's subsystems (steps 1-8 only — no new HTTP listener;
	// the existing listener keeps serving through the swap).
	a.cfg.DataDir = canonical
	if bootErr := a.initVaultSubsystemsOnly(ctx); bootErr != nil {
		return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: open new vault: %w", bootErr)
	}

	// Update app.json: register/refresh the new vault as current.
	// Re-load state after init so any initVaultSubsystemsOnly side effects
	// (e.g. migrations) are reflected.
	state, loadErr = vault.LoadAppJSON(appJSONPath)
	if loadErr != nil {
		return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: reload app.json after boot: %w", loadErr)
	}
	vault.TouchOpened(state, canonical, displayName)
	if saveErr := vault.SaveAppJSON(appJSONPath, state); saveErr != nil {
		return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: persist app.json after switch: %w", saveErr)
	}
	a.setCurrentVaultPath(canonical)

	// Broadcast vault.switched on the OLD hub so the connected SPA tabs
	// receive it and call window.location.reload(). After reload, SPA
	// clients connect to the new hub mounted on the updated router.
	if oldHub != nil {
		oldHub.Broadcast(wshub.EventVaultSwitched, map[string]string{
			"path":         canonical,
			"display_name": displayName,
		}, "")
	}

	// Return the new vault entry for the API response body.
	for _, e := range state.RecentVaults {
		if e.Path == canonical {
			return e, nil
		}
	}
	return vault.RecentVaultEntry{}, fmt.Errorf("SwitchVault: internal: new entry missing after TouchOpened (path=%s)", canonical)
}

// tearDownPerVaultSubsystems closes per-vault state in ADR §3 order.
// Nil-safe: guards every Close call; idempotent (each field is set to nil
// after close so a second call is always a no-op). Does NOT close wshub.Hub
// — the SPA needs to receive vault.switched on the same WS connection.
func (a *App) tearDownPerVaultSubsystems() error {
	// 1. Close sqlite.Pair first (waits for current transactions; releases
	// the DB file lock so the new vault's pair can open the same path if needed).
	if a.pair != nil {
		if err := a.pair.Close(); err != nil {
			a.cfg.Logger.Warn("teardown: pair.Close error (continuing)", "err", err)
		}
		a.pair = nil
	}

	// 2. Clear indexer reference. The indexer holds no background goroutine
	// (per INVESTIGATION.md); any in-progress Reconcile will fail at the next
	// SQL call because the pair is now closed. Setting to nil prevents the new
	// bootPerVaultSubsystems from receiving stale DB references.
	a.indexer = nil

	// 3. Shutdown MCP listener to release port 6684 (V-TEST-1).
	// Use a short timeout: the MCP server should drain in well under 5s.
	if a.mcpShutdown != nil {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := a.mcpShutdown(shutdownCtx); err != nil {
			a.cfg.Logger.Warn("teardown: MCP shutdown error (continuing)", "err", err)
		}
		a.mcpServer = nil
		a.mcpShutdown = nil
	}

	// 4. Close file logger (fsync + release OS file handle).
	if a.fileLogCloser != nil {
		if err := a.fileLogCloser.Close(); err != nil {
			a.cfg.Logger.Warn("teardown: fileLogCloser.Close error (continuing)", "err", err)
		}
		a.fileLogCloser = nil
	}

	// 5. wshub.Hub: DO NOT close. The SPA still needs the WS connection to
	// receive vault.switched and trigger window.location.reload(). The old
	// hub reference in a.hub will be replaced by bootPerVaultSubsystems
	// step 8 (which calls wshub.New). The old hub is GC'd when the last
	// client disconnects during the SPA reload.

	return nil
}

package vault

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
)

// RecentVaultsCap is the maximum number of recent vaults retained (V8).
// LRU eviction by LastOpenedAt removes the oldest entry when exceeded.
const RecentVaultsCap = 10

// SaveAppJSON writes state atomically via fsstore.AtomicWrite (DATA-13 / V15).
// Parent directory is created with 0700 if absent. File mode is 0600.
func SaveAppJSON(path string, state *AppState) error {
	if state.RecentVaults == nil {
		state.RecentVaults = []RecentVaultEntry{}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("mkdir app home: %w", err)
	}
	// Newest-first before write so on-disk order matches load-time sort.
	sort.SliceStable(state.RecentVaults, func(i, j int) bool {
		return state.RecentVaults[i].LastOpenedAt.After(state.RecentVaults[j].LastOpenedAt)
	})
	b, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal app.json: %w", err)
	}
	if err := fsstore.AtomicWrite(path, b); err != nil {
		return fmt.Errorf("atomic write app.json: %w", err)
	}
	// Chmod after rename (AtomicWrite may inherit umask).
	_ = os.Chmod(path, 0o600)
	return nil
}

// TouchOpened registers or refreshes a vault entry in state.RecentVaults.
// path MUST already be canonicalized by the caller (vault.Canonicalize).
// V8: list is capped at 10 entries with LRU eviction by LastOpenedAt.
// V10: canonical match → update existing entry, no duplicate.
// Also sets state.CurrentVault to path (caller may later clear it).
func TouchOpened(state *AppState, canonical, displayName string) {
	now := time.Now().UTC()
	// Canonical-match update path.
	for i := range state.RecentVaults {
		if state.RecentVaults[i].Path == canonical {
			state.RecentVaults[i].LastOpenedAt = now
			state.RecentVaults[i].Missing = false
			state.CurrentVault = canonical
			return
		}
	}
	// New entry.
	state.RecentVaults = append(state.RecentVaults, RecentVaultEntry{
		Path:         canonical,
		DisplayName:  displayName,
		LastOpenedAt: now,
		CreatedAt:    now,
	})
	// LRU eviction (V8): sort newest-first, truncate to cap.
	sort.SliceStable(state.RecentVaults, func(i, j int) bool {
		return state.RecentVaults[i].LastOpenedAt.After(state.RecentVaults[j].LastOpenedAt)
	})
	if len(state.RecentVaults) > RecentVaultsCap {
		state.RecentVaults = state.RecentVaults[:RecentVaultsCap]
	}
	state.CurrentVault = canonical
}

// Forget removes the entry with the matching canonical path. No-op if absent.
// Also clears CurrentVault if it matches.
func Forget(state *AppState, canonical string) {
	out := state.RecentVaults[:0]
	for _, e := range state.RecentVaults {
		if e.Path != canonical {
			out = append(out, e)
		}
	}
	state.RecentVaults = out
	if state.CurrentVault == canonical {
		state.CurrentVault = ""
	}
}

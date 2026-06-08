package vault

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync/atomic"
	"time"
)

var loaderLogWriter atomic.Value

// SetLoaderLog wires an io.Writer that LoadAppJSON uses to surface
// corrupt-reset events. Lifecycle bring-up passes the file logger.
// When unset, corrupt events are silent — acceptable for tests; the backup
// file on disk is sufficient evidence.
func SetLoaderLog(w io.Writer) {
	loaderLogWriter.Store(w)
}

func loaderLog() io.Writer {
	if v := loaderLogWriter.Load(); v != nil {
		if w, ok := v.(io.Writer); ok {
			return w
		}
	}
	return nil
}

// LoadAppJSON reads the app-level registry from `path`.
//
// Semantics (V11 + V12):
//   - file missing → returns (empty state, nil) AND writes the empty state via
//     SaveAppJSON(path, empty) so the file exists for subsequent reads.
//   - valid JSON → returns the unmarshalled state. recent_vaults are then
//     os.Stat-probed: any entry whose path no longer exists gets Missing=true
//     (entries are NOT removed — the user may want to "Reconnect…").
//   - invalid JSON OR read-error other than ENOENT → the existing file is
//     moved aside to "app.json.corrupt.<unix-ts>", a fresh empty state is
//     written via SaveAppJSON, and (&empty, nil) is returned. The corrupt-
//     reset path is NEVER surfaced as a static error page (mirrors PROJECT.md
//     posture: derived registry, vaults still exist on disk).
func LoadAppJSON(path string) (*AppState, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			empty := &AppState{RecentVaults: []RecentVaultEntry{}}
			if saveErr := SaveAppJSON(path, empty); saveErr != nil {
				return nil, fmt.Errorf("create empty app.json: %w", saveErr)
			}
			return empty, nil
		}

		return corruptResetAppJSON(path, err)
	}

	var state AppState
	if jsonErr := json.Unmarshal(raw, &state); jsonErr != nil {
		return corruptResetAppJSON(path, jsonErr)
	}
	if state.RecentVaults == nil {
		state.RecentVaults = []RecentVaultEntry{}
	}

	for i := range state.RecentVaults {
		p := state.RecentVaults[i].Path
		if _, sErr := os.Stat(p); sErr != nil {
			state.RecentVaults[i].Missing = true
		} else if _, jsErr := os.Stat(filepath.Join(p, SubdirName)); jsErr != nil {
			state.RecentVaults[i].Missing = true
		} else {
			state.RecentVaults[i].Missing = false
		}
	}

	sort.SliceStable(state.RecentVaults, func(i, j int) bool {
		return state.RecentVaults[i].LastOpenedAt.After(state.RecentVaults[j].LastOpenedAt)
	})

	return &state, nil
}

func corruptResetAppJSON(path string, cause error) (*AppState, error) {
	ts := time.Now().Unix()
	backup := fmt.Sprintf("%s.corrupt.%d", path, ts)

	_ = os.Rename(path, backup)
	empty := &AppState{RecentVaults: []RecentVaultEntry{}}
	if err := SaveAppJSON(path, empty); err != nil {
		return nil, fmt.Errorf("write fresh app.json after corrupt-backup (%v): %w", cause, err)
	}

	if w := loaderLog(); w != nil {
		_, _ = fmt.Fprintf(w, "vault.LoadAppJSON: app.json unreadable (%v); backed up to %s; fresh empty registry written\n", cause, backup)
	}
	return empty, nil
}

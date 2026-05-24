package app

// lifecycle_vault.go — Plan 08-17b Task 2: vaultMode discriminator.
//
// resolveVaultMode reads app.json and returns:
//   - modeOpen: current_vault exists, folder exists, .jasper/ is a directory.
//   - modeNoVault: anything else; banner string explains why (V13/V14).
//
// V13: current_vault set but folder missing → modeNoVault + banner
//      "Previous vault **<name>** at `<path>` is no longer accessible."
//
// V14: current_vault set + folder exists + .jasper/ missing/corrupt →
//      modeNoVault + banner "…its Jasper data (.jasper/) is missing or
//      corrupt. Re-open it via the picker to recreate the index."
//      DO NOT auto-rebuild — V14 is explicit about this.
//
// Side effects for V13 + V14: current_vault cleared + matching entry
// marked missing=true via vault.SaveAppJSON (atomic write per DATA-13).

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

// vaultMode discriminates the boot state the lifecycle.Run should take.
type vaultMode int

const (
	// modeNoVault means no vault is currently open. The server serves
	// the SPA picker shell + /vault/* handlers only.
	modeNoVault vaultMode = iota

	// modeOpen means a vault folder with a valid .jasper/ directory was
	// found. The server brings up the full per-vault subsystem stack.
	modeOpen
)

// resolveVaultMode reads app.json and determines the boot mode.
//
// vaultOverride is the canonical path from --vault; when non-empty it
// is used instead of app.json's current_vault (same V13/V14 fall-through
// if the override path is bad).
//
// Returns (mode, banner, openPath, err):
//   - mode: modeOpen or modeNoVault
//   - banner: non-empty for V13/V14 conditions; read by GetVaultRecent
//   - openPath: the canonical vault path (only valid when mode==modeOpen)
//   - err: returned only for filesystem errors that prevent reading app.json
func resolveVaultMode(appJSONPath, vaultOverride string) (mode vaultMode, banner string, openPath string, err error) {
	state, err := vault.LoadAppJSON(appJSONPath)
	if err != nil {
		return modeNoVault, "", "", err
	}

	target := state.CurrentVault
	if vaultOverride != "" {
		canonical, cErr := vault.Canonicalize(vaultOverride)
		if cErr != nil {
			return modeNoVault, "", "", fmt.Errorf("--vault: %w", cErr)
		}
		target = canonical
	}

	if target == "" {
		return modeNoVault, "", "", nil
	}

	// V13: folder missing.
	if _, sErr := os.Stat(target); sErr != nil {
		name := filepath.Base(target)
		for _, e := range state.RecentVaults {
			if e.Path == target {
				name = e.DisplayName
				break
			}
		}
		banner = fmt.Sprintf("Previous vault **%s** at `%s` is no longer accessible.", name, target)

		// Side effect: clear current_vault + mark entry missing.
		state.CurrentVault = ""
		for i := range state.RecentVaults {
			if state.RecentVaults[i].Path == target {
				state.RecentVaults[i].Missing = true
			}
		}
		if saveErr := vault.SaveAppJSON(appJSONPath, state); saveErr != nil {
			return modeNoVault, banner, "", fmt.Errorf("clear stale current_vault (V13): %w", saveErr)
		}
		return modeNoVault, banner, "", nil
	}

	// V14: folder exists but .jasper/ missing or not a directory.
	jasperDir := filepath.Join(target, ".jasper")
	info, sErr := os.Stat(jasperDir)
	if sErr != nil || !info.IsDir() {
		name := filepath.Base(target)
		for _, e := range state.RecentVaults {
			if e.Path == target {
				name = e.DisplayName
				break
			}
		}
		banner = fmt.Sprintf(
			"Previous vault **%s** at `%s` exists but its Jasper data (`.jasper/` folder) is missing or corrupt. Re-open it via the picker to recreate the index.",
			name, target,
		)

		// Side effect: clear current_vault + mark entry missing.
		state.CurrentVault = ""
		for i := range state.RecentVaults {
			if state.RecentVaults[i].Path == target {
				state.RecentVaults[i].Missing = true
			}
		}
		if saveErr := vault.SaveAppJSON(appJSONPath, state); saveErr != nil {
			return modeNoVault, banner, "", fmt.Errorf("clear missing-.jasper current_vault (V14): %w", saveErr)
		}
		return modeNoVault, banner, "", nil
	}

	return modeOpen, "", target, nil
}

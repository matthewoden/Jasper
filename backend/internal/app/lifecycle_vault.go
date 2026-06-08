package app

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

type vaultMode int

const (
	modeNoVault vaultMode = iota

	modeOpen
)

func resolveVaultMode(appJSONPath, vaultOverride string) (mode vaultMode, banner string, openPath string, err error) {
	state, err := vault.LoadAppJSON(appJSONPath)
	if err != nil {
		return modeNoVault, "", "", err
	}

	if vaultOverride != "" {
		canonical, cErr := vault.Canonicalize(vaultOverride)
		if cErr != nil {
			return modeNoVault, "", "", fmt.Errorf("--vault: %w", cErr)
		}

		if _, sErr := os.Stat(canonical); sErr != nil {
			return modeNoVault, "", "", fmt.Errorf("--vault path does not exist: %s", canonical)
		}

		return modeOpen, "", canonical, nil
	}

	target := state.CurrentVault
	if target == "" {
		return modeNoVault, "", "", nil
	}

	if _, sErr := os.Stat(target); sErr != nil {
		name := filepath.Base(target)
		for _, e := range state.RecentVaults {
			if e.Path == target {
				name = e.DisplayName
				break
			}
		}
		banner = fmt.Sprintf("Previous vault **%s** at `%s` is no longer accessible.", name, target)

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

	jasperDir := filepath.Join(target, vault.SubdirName)
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

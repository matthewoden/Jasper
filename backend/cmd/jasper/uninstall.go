package main

import (
	"fmt"
	"os"
	"runtime"

	"github.com/spf13/cobra"

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/installer"
)

var uninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Unregister Jasper from launchd / systemd",
	Long: `Remove the Jasper service registration.

On macOS: launchctl bootout the LaunchAgent + remove the plist.
On Linux / WSL2: systemctl stop + disable + disable-linger + remove the unit.

Notes:
  - Your .md files in the data directory are NOT touched.
  - Your SQLite index is NOT touched. To start fresh, delete the data
    directory manually after uninstall.
  - Idempotent — safe to run even if Jasper wasn't installed.`,
	RunE: func(_ *cobra.Command, _ []string) error {
		dataDir := config.DefaultDataDir()
		svc, err := installer.New(dataDir)
		if err != nil {
			return fmt.Errorf("create service config: %w", err)
		}

		switch runtime.GOOS {
		case "darwin":
			if plistPath, perr := installer.PlistPathMacOS(); perr == nil {
				_ = installer.BootoutMacOS(plistPath)
			}
		case "linux":
			_ = svc.Stop()
			_ = installer.DisableLingerLinux()
		}
		if err := svc.Uninstall(); err != nil {
			fmt.Fprintf(os.Stderr, "(service file removal: %s — continuing)\n", err)
		}
		fmt.Println("Jasper uninstalled. Your notes remain at the data directory.")
		return nil
	},
}

func init() { rootCmd.AddCommand(uninstallCmd) }

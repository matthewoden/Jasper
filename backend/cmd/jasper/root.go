// Package main: cobra root command for the `jasper` CLI.
// Subcommands self-register in their own *.go file via init() → rootCmd.AddCommand.
package main

import (
	"github.com/spf13/cobra"
)

var vaultFlag string

var rootCmd = &cobra.Command{
	Use:   "jasper",
	Short: "Jasper — a lightweight, self-hosted markdown notes app",
	Long: `Jasper is a single-user markdown notes server that runs as a native
service on your machine. Notes live as plain .md files on disk; SQLite
holds a derived index for search. No plugins, no extensions, no cloud.

Common subcommands:
  serve       Start the HTTP + WebSocket server (default for service mode)
  install     Register Jasper as a per-user launchd LaunchAgent (macOS)
              or systemd user unit (WSL2)
  uninstall   Unregister the service
  status      Show the running service's state, address, and log path
  doctor      Diagnose install/runtime issues with plain-English remediation
  version     Print the binary version and build commit`,
	SilenceUsage: true,
}

func init() {
	rootCmd.PersistentFlags().StringVar(&vaultFlag, "vault", "",
		"Absolute path to the vault to open (overrides app.json current_vault). "+
			"When unset, the server reads ~/.jasper/app.json (or $JASPER_APP_HOME/app.json) "+
			"to find current_vault; if that is unset, the picker is served at /.")
}

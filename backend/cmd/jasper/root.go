// Package main: cobra root command for the `jasper` CLI.
//
// Phase 8 Plan 08-11 migrates from a stdlib `flag`-based switch dispatch
// (the Phase 1 pattern) to cobra. The trigger was the install/uninstall/
// status/doctor subcommand surface that 08-12 adds — once we cross
// 3-4 user-facing subcommands, hand-rolled dispatch becomes more code
// than the cobra dep saves. See 08-CONTEXT.md D-34 + 08-RESEARCH.md
// Open Question #4 (Long-help strings hand-tuned, not generated).
//
// Subcommands self-register in their own *.go file's init() via
// rootCmd.AddCommand(...) so this file stays a single registration
// surface.
package main

import (
	"github.com/spf13/cobra"
)

// rootCmd is the top-level `jasper` cobra command. `main.go` simply
// calls rootCmd.Execute() and returns its exit code.
//
// SilenceUsage suppresses the noisy "usage:" dump on every error —
// cobra's default behavior makes a single Run() error look like a
// CLI misuse, which is wrong for a server that hit a runtime fault.
// The error is still printed; just not the usage banner.
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

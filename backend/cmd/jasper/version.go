package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

// buildVersion + buildCommit are package-level vars so they can be set
// via `-ldflags "-X main.buildVersion=... -X main.buildCommit=..."` at
// build time. Phase 1 didn't wire ldflags yet — defaults preserve the
// existing Phase 1 `jasper 0.1.0-phase1` smoke-test contract until the
// Makefile gains the -ldflags injection (08-15 / packaging work).
//
// The legacy `jasper 0.1.0-phase1` output is preserved when
// buildCommit == "" (i.e. no ldflags injection) — versionString()
// returns it verbatim so existing Phase 1 smoke tests pass unchanged.
// Once a build commit is injected, the output switches to the new
// "jasper {ver} (commit {sha})" format.
var (
	buildVersion = "0.1.0-phase1"
	buildCommit  = ""
)

// versionString builds the user-visible version line.
//
// Backward-compat: when buildCommit is empty (no ldflags injection
// active), we return the exact Phase 1 string so the existing smoke
// test assertion ("jasper 0.1.0-phase1") still passes. Once a build
// pipeline injects a commit SHA, the richer "(commit ...)" suffix
// kicks in.
func versionString() string {
	if buildCommit == "" {
		return fmt.Sprintf("jasper %s", buildVersion)
	}
	return fmt.Sprintf("jasper %s (commit %s)", buildVersion, buildCommit)
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the binary version and build commit",
	Long: `Print the Jasper binary's version and the git commit it was built from.

Useful for confirming an install or comparing versions across machines.

Example:
  $ jasper version
  jasper 0.1.0 (commit abc1234)`,
	RunE: func(cmd *cobra.Command, _ []string) error {
		// cmd.OutOrStdout() lets tests capture the output via SetOut.
		_, err := fmt.Fprintln(cmd.OutOrStdout(), versionString())
		return err
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}

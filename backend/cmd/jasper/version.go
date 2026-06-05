package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

var (
	buildVersion = "0.1.0-phase1"
	buildCommit  = ""
)

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
		_, err := fmt.Fprintln(cmd.OutOrStdout(), versionString())
		return err
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}

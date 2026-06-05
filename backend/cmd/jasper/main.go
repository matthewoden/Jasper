// Command jasper is the single Go binary that serves both the embedded
// React SPA and the OpenAPI-typed backend on 127.0.0.1 by default.
//
// Phase 8 Plan 08-11 migrated dispatch from a stdlib `flag`-based switch
// to cobra (rootCmd in root.go); subcommands self-register in their own
// *.go files via init() → rootCmd.AddCommand. main() is now a single-line
// Execute() call — all CLI surface lives in cobra.
//
// Phase 1 exposed two subcommands (`serve` + `version`); 08-12 adds
// install / uninstall / status / doctor on top of the same root.
package main

import (
	"os"
)

func main() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

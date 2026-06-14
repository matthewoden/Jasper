// Command jasper is the single Go binary that serves both the embedded
// React SPA and the OpenAPI-typed backend on 127.0.0.1 by default.
// Subcommands self-register in their own *.go files via init() → rootCmd.AddCommand.
package main

import (
	"os"
)

func main() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

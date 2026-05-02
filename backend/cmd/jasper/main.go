// Command jasper is the single Go binary that serves both the embedded
// React SPA and the OpenAPI-typed backend on 127.0.0.1 by default.
//
// Phase 1 exposes two subcommands: `jasper serve` (run the server) and
// `jasper version` (print the build identifier). Phase 8 adds install /
// uninstall / start / stop / doctor via kardianos/service.
//
// We deliberately use stdlib `flag` instead of cobra in Phase 1 — there
// is exactly one user-facing subcommand here, and adding cobra ahead of
// the real subcommand surface would be premature dependency-bloat.
// Phase 8 may revisit when there are 5+ subcommands to coordinate.
package main

import (
	"fmt"
	"os"
)

// version is the build identifier printed by `jasper version`. Phase 8
// will inject this via -ldflags at build time; Phase 1 just hard-codes
// it so the smoke test has something to assert against.
const version = "jasper 0.1.0-phase1"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: jasper <serve|version>")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		if err := runServe(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "jasper: serve:", err)
			os.Exit(1)
		}
	case "version":
		fmt.Println(version)
	case "-h", "--help", "help":
		fmt.Println("usage: jasper <serve|version>")
		fmt.Println("  serve    run the server")
		fmt.Println("  version  print build identifier")
	default:
		fmt.Fprintln(os.Stderr, "unknown subcommand:", os.Args[1])
		os.Exit(2)
	}
}

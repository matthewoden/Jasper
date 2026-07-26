// Package buildinfo exposes the running binary's version string to internal
// packages that cannot import cmd/jasper — Go forbids importing a `main`
// package, and the About pane (GET /vault/about, Phase 32) needs the version
// string server-side. cmd/jasper's `jasper version` subcommand reads these
// same vars back so there is exactly one source of truth.
//
// No -ldflags injection point exists in this repo (verified by grep across
// Makefile and .github/workflows/*.yml), so these are plain static values,
// not build-time overrides.
package buildinfo

// Version is the Jasper binary's version string.
var Version = "0.1.0-phase1"

// Commit is the git commit the binary was built from. Empty when unknown.
var Commit = ""

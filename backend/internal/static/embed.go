// Package static embeds the Vite-built SPA (frontend/dist/, copied into
// ./dist/ by `make build`) into the Go binary at build time and exposes
// it as an io/fs.FS. The `all:` prefix ensures hidden files (e.g.
// .vite/manifest.json if Vite emits it) are included.
//
// The embed source path is relative to this file
// (backend/internal/static/embed.go), so `all:dist` resolves to
// backend/internal/static/dist/. The Makefile build target copies
// frontend/dist/ → backend/internal/static/dist/ before `go build`.
// A .keep file in dist/ ensures this package compiles on a fresh
// clone before `make build` has been run.
package static

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// FS returns the SPA assets rooted at the dist/ subdirectory.
//
// Panics on construction failure because a missing dist/ subdirectory
// indicates a build-time misconfiguration that no runtime can recover
// from — the binary should fail loudly at startup rather than 404 every
// request silently.
func FS() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic("static: embedded dist/ subdirectory unavailable: " + err.Error())
	}
	return sub
}

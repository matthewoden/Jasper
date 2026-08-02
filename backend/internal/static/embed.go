// Package static embeds the Vite-built SPA, which `make build` copies into
// ./dist/ before `go build`.
//
// The `all:` prefix is required or hidden files are skipped. The .keep file
// exists so a fresh clone compiles before `make build` has ever run.
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

// Package errorpage embeds the static HTML pages served when boot
// cannot complete (disk-full pre-flight, unrecoverable migration state).
//
// These pages are served when the migration runner aborts and the React
// SPA cannot load (no API to talk to). The Go binary serves a
// self-contained HTML file directly on the listen address instead of
// the SPA shell.
//
// Files in this directory must match `*.html`. Templates use Go's
// html/template syntax with struct-typed data passed by the caller
// (see backend/internal/app/disk_full_handler.go).
package errorpage

import "embed"

// FS embeds disk-full.html and unrecoverable.html as a read-only
// io/fs.FS. The handler reads a named template out of FS at request
// time; the file count is small enough that templates are not cached
// (every render is a fresh parse).
//
//go:embed *.html
var FS embed.FS

// Package errorpage embeds the static HTML pages served when boot
// cannot complete (DATA-07 disk-full pre-flight, Path 3 unrecoverable
// migration state). UI-SPEC §Surface 4.
//
// These pages are the only Phase 2 UI that lives outside frontend/src/
// — when the migration runner aborts, the React SPA cannot load (no
// API to talk to), so the Go binary serves a self-contained HTML file
// directly on `127.0.0.1:3000` instead of the SPA shell.
//
// Files in this directory must match `*.html`. Templates use Go's
// html/template syntax with struct-typed data passed in by the
// caller (see backend/internal/app/disk_full_handler.go).
package errorpage

import "embed"

// FS embeds disk-full.html and unrecoverable.html as a read-only
// io/fs.FS. The handler in backend/internal/app/disk_full_handler.go
// reads a named template out of FS at request time (the file count
// is small enough that we don't bother caching parsed templates;
// see T-02-06-04 — every render is a fresh parse so a hot-reload
// of the .html file via re-build is the only intended workflow).
//
//go:embed *.html
var FS embed.FS

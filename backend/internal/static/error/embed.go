// Package errorpage embeds the self-contained HTML served when boot cannot
// complete and the SPA has no API to talk to.
package errorpage

import "embed"

// FS embeds disk-full.html and unrecoverable.html as a read-only
// io/fs.FS. The handler reads a named template out of FS at request
// time; the file count is small enough that templates are not cached
// (every render is a fresh parse).
//
//go:embed *.html
var FS embed.FS

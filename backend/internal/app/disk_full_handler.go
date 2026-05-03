// File: disk_full_handler.go
//
// Despite the file name, this file owns BOTH boot-error static pages:
// disk-full.html (DATA-07 — disk-space pre-flight aborted) and
// unrecoverable.html (Path 3 — Path 1 restore itself failed, or Path 2
// also failed). The file name is retained from the Plan 02-06 / Task 1
// stub to minimize churn; the function name (newBootErrorHandler) is
// the canonical, dual-purpose API.
//
// Both pages are embedded into the binary at build time via
// backend/internal/static/error/embed.go and served by
// newBootErrorHandler at request time. The handler renders the named
// template against a typed data struct (DiskFullData /
// UnrecoverableData), substituting placeholders into the static HTML.
//
// When the boot-error handler is mounted on the listener (lifecycle.Run
// installs it on ErrDiskFull or ErrUnrecoverable), it serves a 503 to
// EVERY request. /api/* paths get JSON 503 with code "unrecoverable"
// so a polling client can parse the error; everything else gets the
// rendered HTML page so a browser tab shows the user the situation.

package app

import (
	"html/template"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"syscall"

	errorpage "github.com/matthewoden/jasper/backend/internal/static/error"
)

// DiskFullData carries the values rendered into disk-full.html when the
// migration runner aborts the disk-space pre-flight (DATA-07). Field
// names mirror the {{.RequiredMB}} / {{.AvailableMB}} / {{.DataDir}}
// placeholders in the template (UI-SPEC §Surface 4).
type DiskFullData struct {
	RequiredMB  int64
	AvailableMB int64
	DataDir     string
}

// UnrecoverableData carries the values rendered into unrecoverable.html
// when the runner returns ErrUnrecoverable (Path 1 restore itself
// failed, or Path 2 also failed). The LogsPath is the absolute log
// file path the user can tail to see the full migration error chain.
type UnrecoverableData struct {
	LogsPath string
}

// buildDiskFullData inspects the disk to populate the disk-full
// template values. Falls back to 0 / "" if the stat or statfs fails —
// the user will see empty fields, which is still informative ("Jasper
// couldn't start"). RequiredMB is computed as 2× the current app.db
// size in MB (DATA-07 heuristic from DESIGN.md §4.4).
func buildDiskFullData(dbPath, dataDir string) DiskFullData {
	var requiredMB, availableMB int64
	if info, err := os.Stat(dbPath); err == nil {
		// 2× the current size, in MB.
		requiredMB = (info.Size() * 2) / (1024 * 1024)
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(dataDir, &stat); err == nil {
		// Statfs.Bavail is "blocks available to non-superuser"; multiply
		// by block size and divide by MB to get the user-facing number.
		// Cast both sides to uint64 because Bsize is int32 on Darwin
		// and int64 on Linux; uint64 covers both without overflow on
		// disks up to ~16 EiB.
		availableMB = int64(uint64(stat.Bavail) * uint64(stat.Bsize) / (1024 * 1024))
	}
	return DiskFullData{
		RequiredMB:  requiredMB,
		AvailableMB: availableMB,
		DataDir:     dataDir,
	}
}

// buildUnrecoverableData populates the unrecoverable.html template
// values. Mirrors buildDiskFullData (same package). LogsPath is the
// absolute path the user can tail to see the full migration error
// chain (UI-SPEC §Surface 4 voice rules).
func buildUnrecoverableData(logsPath string) UnrecoverableData {
	return UnrecoverableData{LogsPath: logsPath}
}

// newBootErrorHandler returns an http.Handler that serves a single
// static error page for ALL requests (including /api/v1/...). When
// boot fails, the SPA cannot load and the API has no DB to talk to;
// the right behavior is to serve the error page on every path so the
// user sees it regardless of which URL their browser hit.
//
// templateName must match a file in errorpage.FS (e.g. "disk-full.html"
// or "unrecoverable.html"). data is the template-specific struct
// (DiskFullData or UnrecoverableData) — typed `any` here so the
// handler is template-agnostic.
//
// Response shape:
//
//   - /api/* paths get 503 + JSON envelope {code:"unrecoverable", message:...}
//     so a polling client (e.g. the React MigrationBanner's status
//     poll) can parse it.
//   - All other paths get 503 + the templated HTML page rendered
//     against `data`.
//
// Cache-Control: no-store on every response so a browser tab does
// not cache the error page (the user fixes the disk-space problem,
// restarts the binary, and reloads — they should see the SPA, not
// the cached error).
func newBootErrorHandler(templateName string, data any) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")

		// API paths get JSON so a polling client can parse the error.
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w, `{"code":"unrecoverable","message":"server is in unrecoverable state — see disk-full or logs"}`)
			return
		}

		// HTML path: read template from embedded FS, parse, execute.
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)

		tmplBytes, err := errorpage.FS.ReadFile(templateName)
		if err != nil {
			slog.Default().Error("boot-error template read failed",
				"err", err, "template", templateName)
			return
		}
		tmpl, err := template.New(templateName).Parse(string(tmplBytes))
		if err != nil {
			slog.Default().Error("boot-error template parse failed",
				"err", err, "template", templateName)
			return
		}
		if err := tmpl.Execute(w, data); err != nil {
			// Headers + status already sent; the only recourse is to
			// log server-side. The client will see a partial body.
			slog.Default().Error("boot-error template execute failed",
				"err", err, "template", templateName)
		}
	})
}

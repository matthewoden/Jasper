package app

import (
	"io"
	"net/http"
	"strings"
)

// DiskFullData carries the values rendered into disk-full.html when the
// migration runner aborts the disk-space pre-flight (DATA-07). Field
// names mirror the {{.RequiredMB}} / {{.AvailableMB}} / {{.DataDir}}
// placeholders in the template.
//
// Phase 2 — Plan 02-06 / Task 1: this type and the helpers below have
// only the minimum structure needed for lifecycle.Run to wire the
// boot-error path. Plan 02-06 / Task 2 lands the html/template-backed
// renderer + the embedded disk-full.html + unrecoverable.html files
// + the full test surface.
type DiskFullData struct {
	RequiredMB  int64
	AvailableMB int64
	DataDir     string
}

// UnrecoverableData carries the values rendered into unrecoverable.html
// when the runner returns ErrUnrecoverable (Path 1 restore failed, or
// Path 2 also failed). Filled by buildUnrecoverableData.
type UnrecoverableData struct {
	LogsPath string
}

// buildDiskFullData inspects the data dir to populate the disk-full
// template values. Plan 02-06 / Task 2 fleshes this out with actual
// stat / statfs lookups; for Task 1 a placeholder body is enough to
// keep lifecycle.Run compiling and the disk-full path reachable.
func buildDiskFullData(dbPath, dataDir string) DiskFullData {
	return DiskFullData{
		RequiredMB:  0,
		AvailableMB: 0,
		DataDir:     dataDir,
	}
}

// buildUnrecoverableData populates the unrecoverable.html template
// values. The LogsPath is the absolute path the user can tail to see
// the full migration error chain (UI-SPEC §Surface 4 voice rules).
func buildUnrecoverableData(logsPath string) UnrecoverableData {
	return UnrecoverableData{LogsPath: logsPath}
}

// newBootErrorHandler returns an http.Handler that serves a single
// static error page for ALL requests (including /api/v1/...). When
// boot fails, the SPA cannot load and the API has no DB to talk to;
// the right behavior is to serve the error page on every path so the
// user sees it regardless of which URL their browser hit.
//
// templateName must match an entry under the embedded errorpage.FS
// (e.g. "disk-full.html" or "unrecoverable.html"). data is the
// template-specific struct (DiskFullData or UnrecoverableData) — typed
// `any` so the handler is template-agnostic.
//
// Plan 02-06 / Task 1: minimal compileable stub. Task 2 replaces the
// body with the html/template + go:embed implementation defined by
// UI-SPEC §Surface 4. The signature is locked here so lifecycle.Run
// can wire it in this task's commit.
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
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		// Task 2 replaces this stub with a templated render of
		// errorpage.FS[templateName] using `data`. For now write a
		// minimal HTML body so lifecycle.Run has a real handler in
		// place; the bytes here are NOT the UI-SPEC copy, they are
		// just enough to keep the path compileable.
		_, _ = io.WriteString(w, "<!doctype html><title>Jasper</title><p>Boot error.</p>")
		_ = templateName
		_ = data
	})
}

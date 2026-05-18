// File: startup_error_page.go
//
// D-11 startup-failure static HTML error page (UI-SPEC §Surface 7). When
// the pre-listener lifecycle init fails (migration error, indexer init
// failure, frontmatter scaffold failure, etc.) — but the failure is NOT
// already covered by ErrDiskFull or ErrUnrecoverable — Jasper still
// binds the HTTP listener and serves a self-contained, dark-themed
// static page identifying the failure, a suggested user-facing action,
// and the most recent log lines.
//
// Phase 8 deviation from disk_full_handler.go (the EXACT analog): this
// handler returns HTTP 500 (not 503) because the failure is a server-
// internal init error rather than a temporary unavailable state. API
// paths still get a JSON envelope (503 — clients should retry after the
// user reads the page and restarts the binary) so any polling client
// can parse the response.
//
// CRITICAL — never wrap the template fields in template.HTML(). All
// four fields are plain `string` and rely on html/template's default
// auto-escape mode (the load-bearing XSS guard per UI-SPEC §Forward-
// Compatibility Assert #8 and threat T-08-12).

package app

import (
	"html/template"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"

	errorpage "github.com/matthewoden/jasper/backend/internal/static/error"
)

// StartupErrorData feeds the startup-error.html template (UI-SPEC §Surface 7).
//
//   - PhaseName: human-friendly init-step name (e.g. "Migration",
//     "Migration 004_mcp_grants.sql", "Index rebuild"). Auto-escaped.
//   - ErrorSummary: short text from err.Error() — must NOT contain a
//     stack trace (caller sanitizes). Auto-escaped by html/template
//     so SQL or filesystem error messages containing `<` or `>` cannot
//     break out of the surrounding paragraph.
//   - SuggestedAction: one of three short user-facing strings — one of
//     "Run jasper doctor", "Restore from your most recent backup", or
//     "Free up disk space and retry". Picked by suggestedActionFor.
//   - LogExcerpt: last ~20 lines of jasper.log. Rendered inside a
//     <pre> block; html/template auto-escapes < > & so log content
//     cannot break out of the pre.
type StartupErrorData struct {
	PhaseName       string
	ErrorSummary    string
	SuggestedAction string
	LogExcerpt      string
}

// newStartupErrorHandler returns an http.Handler that serves the
// startup-failure static page (HTML to browsers, JSON envelope to
// /api/* clients). Mounted by lifecycle.go on the listener BEFORE
// the SPA mount-point when init fails.
//
// Mirrors the disk_full_handler.go newBootErrorHandler pattern (D-11 +
// 08-RESEARCH.md — disk_full_handler.go is the exact analog).
//
// Response shape:
//
//   - /api/* paths get HTTP 503 + JSON `{"code":"startup_failed", ...}`
//   - All other paths get HTTP 500 + the rendered HTML page.
//
// Cache-Control: no-store on every response so a browser tab does not
// cache the error page; once the user fixes the underlying problem and
// restarts the binary they should see the SPA on reload, not a cached
// page.
func newStartupErrorHandler(data StartupErrorData) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")

		// API clients get a structured JSON envelope so a polling client
		// can parse the failure programmatically.
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w,
				`{"code":"startup_failed","message":"Jasper is starting and one of the startup steps failed. See / in the browser for details."}`)
			return
		}

		// HTML path: read template from embedded FS, parse, execute.
		// Last-resort plaintext fallback if the embedded template went
		// missing — should be unreachable in a healthy binary.
		tmplBytes, err := errorpage.FS.ReadFile("startup-error.html")
		if err != nil {
			slog.Default().Error("startup-error template read failed", "err", err)
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, "Jasper couldn't start. See server log.")
			return
		}
		tmpl, err := template.New("startup-error").Parse(string(tmplBytes))
		if err != nil {
			slog.Default().Error("startup-error template parse failed", "err", err)
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, "Jasper couldn't start (template parse error).")
			return
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		if execErr := tmpl.Execute(w, data); execErr != nil {
			// Headers + status already sent; only recourse is server-side log.
			slog.Default().Error("startup-error template execute failed", "err", execErr)
		}
	})
}

// suggestedActionFor maps an init-time error to a short user-facing
// suggestion string (D-11). The mapping is intentionally coarse —
// startup-error UX is a "tell the user the next step" surface, not a
// full diagnostic. The three legal return values match UI-SPEC §Surface 7
// copy expectations.
//
// Heuristic (in priority order):
//
//  1. If the error message contains "migration" or "sql" (case-
//     insensitive) → "Run jasper doctor" (the doctor subcommand owns
//     migration triage per 08-CONTEXT D-11 / D-23).
//  2. If it contains "disk" or "space" or "no space left" → "Free up
//     disk space and retry". (ErrDiskFull is caught by lifecycle.Run
//     before this handler runs — this is a fallback for related
//     "out-of-space" errors that don't carry that sentinel.)
//  3. Otherwise → "Restore from your most recent backup" (catch-all —
//     conservative because we don't know what failed).
func suggestedActionFor(err error) string {
	if err == nil {
		return "Restore from your most recent backup"
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "migration") || strings.Contains(msg, "sql") {
		return "Run jasper doctor"
	}
	if strings.Contains(msg, "disk") || strings.Contains(msg, "space") {
		return "Free up disk space and retry"
	}
	return "Restore from your most recent backup"
}

// tailLog reads the last `n` lines from `path` and returns them joined
// with "\n". To bound memory + I/O on a pathologically large log file,
// only the trailing 16 KiB of the file is read; if the file is larger
// the earlier bytes are simply not considered (taking the LAST n lines
// of the last 16 KiB is close enough to the LAST n lines of the file
// for a 20-line excerpt at typical log line widths).
//
// Returns "(no log file yet)" if the file does not exist (the file
// logger ships in 08-12; before that lands, this handler may run with
// no log file present).
//
// Threat T-08-14 mitigation: 16 KiB safety cap prevents an unbounded
// read.
func tailLog(path string, n int) string {
	if path == "" {
		return "(no log file path configured)"
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "(no log file yet)"
		}
		return "(could not read log: " + err.Error() + ")"
	}
	defer func() { _ = f.Close() }()

	const maxRead = 16 * 1024
	info, err := f.Stat()
	if err != nil {
		return "(could not stat log: " + err.Error() + ")"
	}
	size := info.Size()
	var offset int64
	if size > maxRead {
		offset = size - maxRead
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return "(could not seek log: " + err.Error() + ")"
	}
	buf, err := io.ReadAll(f)
	if err != nil {
		return "(could not read log: " + err.Error() + ")"
	}
	lines := strings.Split(strings.TrimRight(string(buf), "\n"), "\n")
	// If we seeked into the middle of a line, drop the (likely partial)
	// first line so the excerpt starts at a real line boundary.
	if offset > 0 && len(lines) > 1 {
		lines = lines[1:]
	}
	if n > 0 && len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	if len(lines) == 0 {
		return "(log file is empty)"
	}
	return strings.Join(lines, "\n")
}

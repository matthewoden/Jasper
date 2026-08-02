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

// StartupErrorData feeds the startup-error.html template.
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

func newStartupErrorHandler(data StartupErrorData) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")

		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w,
				`{"code":"startup_failed","message":"Jasper is starting and one of the startup steps failed. See / in the browser for details."}`)
			return
		}

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
			slog.Default().Error("startup-error template execute failed", "err", execErr)
		}
	})
}

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

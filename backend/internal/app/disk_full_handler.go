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
// failed, or Path 2 also failed). LogsPath is the absolute log file path
// the user can tail for the full migration error chain; LogExcerpt is its
// tail, so the failure is legible without leaving the page.
type UnrecoverableData struct {
	LogsPath   string
	LogExcerpt string
}

func buildDiskFullData(dbPath, dataDir string) DiskFullData {
	var requiredMB, availableMB int64
	if info, err := os.Stat(dbPath); err == nil {
		requiredMB = (info.Size() * 2) / (1024 * 1024)
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(dataDir, &stat); err == nil {
		availableMB = int64(uint64(stat.Bavail) * uint64(stat.Bsize) / (1024 * 1024))
	}
	return DiskFullData{
		RequiredMB:  requiredMB,
		AvailableMB: availableMB,
		DataDir:     dataDir,
	}
}

func buildUnrecoverableData(logsPath string) UnrecoverableData {
	return UnrecoverableData{LogsPath: logsPath, LogExcerpt: tailLog(logsPath, 20)}
}

func newBootErrorHandler(templateName string, data any) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")

		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w, `{"code":"unrecoverable","message":"server is in unrecoverable state — see disk-full or logs"}`)
			return
		}

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
			slog.Default().Error("boot-error template execute failed",
				"err", err, "template", templateName)
		}
	})
}

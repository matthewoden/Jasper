package app

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDiskFullHandler_RootPath_ReturnsHTMLWithCopy — the root path
// (and any non-/api path) gets the rendered disk-full.html with the
// templated values substituted. Asserts:
//   - status 503
//   - Content-Type starts with text/html
//   - body contains the locked headline ("Not enough disk space to start.")
//   - body contains each substituted field ({{.RequiredMB}}, {{.AvailableMB}}, {{.DataDir}})
func TestDiskFullHandler_RootPath_ReturnsHTMLWithCopy(t *testing.T) {
	h := newBootErrorHandler("disk-full.html", DiskFullData{
		RequiredMB:  50,
		AvailableMB: 5,
		DataDir:     "/tmp/foo",
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusServiceUnavailable {
		t.Errorf("status: got %d, want 503", rr.Code)
	}
	ct := rr.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type: got %q, want text/html*", ct)
	}
	body := rr.Body.String()
	wantSubs := []string{
		"Not enough disk space to start.",
		"50 MB",
		"5 MB",
		"/tmp/foo",
		"Your notes are not affected",
	}
	for _, s := range wantSubs {
		if !strings.Contains(body, s) {
			t.Errorf("body missing %q; got:\n%s", s, body)
		}
	}
}

// TestDiskFullHandler_APIPath_ReturnsJSON — a request to /api/v1/...
// returns a JSON 503 envelope so the client can parse it.
func TestDiskFullHandler_APIPath_ReturnsJSON(t *testing.T) {
	h := newBootErrorHandler("disk-full.html", DiskFullData{
		RequiredMB:  10,
		AvailableMB: 1,
		DataDir:     "/tmp/x",
	})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/notes", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusServiceUnavailable {
		t.Errorf("status: got %d, want 503", rr.Code)
	}
	ct := rr.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type: got %q, want application/json", ct)
	}
	body := rr.Body.String()
	if !strings.Contains(body, `"code":"unrecoverable"`) {
		t.Errorf("body did not contain code=unrecoverable: %s", body)
	}
}

// TestDiskFullHandler_NoCache — every response sets Cache-Control:
// no-store so a browser tab does not cache the error page.
func TestDiskFullHandler_NoCache(t *testing.T) {
	h := newBootErrorHandler("disk-full.html", DiskFullData{})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if got := rr.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control: got %q, want no-store", got)
	}
}

// TestDiskFullHandler_TemplateRendersInlineSVG — the inline SVG icon
// is part of the static HTML; confirm both the <svg> tag and the
// literal warning hex (#fbbf24) survives into the
// rendered body.
func TestDiskFullHandler_TemplateRendersInlineSVG(t *testing.T) {
	h := newBootErrorHandler("disk-full.html", DiskFullData{})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	body := rr.Body.String()
	if !strings.Contains(body, "<svg") {
		t.Errorf("body did not contain <svg tag")
	}
	if !strings.Contains(body, "#fbbf24") {
		t.Errorf("body did not contain literal warning hex #fbbf24")
	}
}

// TestUnrecoverableHandler_RootPath_ReturnsHTMLWithCopy (W-7) — the
// unrecoverable.html template carries different copy from disk-full.html.
// Asserts the headline + reset-and-rebuild guidance + LogsPath placeholder.
func TestUnrecoverableHandler_RootPath_ReturnsHTMLWithCopy(t *testing.T) {
	h := newBootErrorHandler("unrecoverable.html", UnrecoverableData{
		LogsPath: "/tmp/jasper.log",
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusServiceUnavailable {
		t.Errorf("status: got %d, want 503", rr.Code)
	}
	body := rr.Body.String()

	wantSubs := []string{
		"Migration couldn",
		"complete safely",
		"reset-and-rebuild",
		"/tmp/jasper.log",
	}
	for _, s := range wantSubs {
		if !strings.Contains(body, s) {
			t.Errorf("body missing %q; got:\n%s", s, body)
		}
	}
}

// TestUnrecoverableHandler_APIPath_ReturnsJSON — same JSON 503 shape
// for /api paths regardless of which template is selected.
func TestUnrecoverableHandler_APIPath_ReturnsJSON(t *testing.T) {
	h := newBootErrorHandler("unrecoverable.html", UnrecoverableData{
		LogsPath: "/tmp/jasper.log",
	})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/status", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusServiceUnavailable {
		t.Errorf("status: got %d, want 503", rr.Code)
	}
	body, _ := io.ReadAll(rr.Body)
	if !strings.Contains(string(body), `"code":"unrecoverable"`) {
		t.Errorf("body did not contain code=unrecoverable: %s", body)
	}
}

// TestBuildDiskFullData_MissingPaths — buildDiskFullData must NOT
// panic when the dbPath does not exist or the dataDir is invalid;
// it falls back to zeros and the user-supplied dataDir string.
func TestBuildDiskFullData_MissingPaths(t *testing.T) {
	got := buildDiskFullData("/nonexistent/path/db", "/nonexistent/dir")
	if got.DataDir != "/nonexistent/dir" {
		t.Errorf("DataDir: got %q, want passthrough", got.DataDir)
	}

	if got.RequiredMB != 0 {
		t.Errorf("RequiredMB: got %d, want 0", got.RequiredMB)
	}
}

// TestBuildUnrecoverableData_PassThrough — buildUnrecoverableData copies
// the LogsPath verbatim.
func TestBuildUnrecoverableData_PassThrough(t *testing.T) {
	got := buildUnrecoverableData("/var/log/jasper.log")
	if got.LogsPath != "/var/log/jasper.log" {
		t.Errorf("LogsPath: got %q, want passthrough", got.LogsPath)
	}
}

// TestUnrecoverablePage_ShowsRealLogLines — an unrecoverable migration is
// the case where the log matters most, and the page used to offer only a
// path. It now tails the file, so the failure is legible in place.
func TestUnrecoverablePage_ShowsRealLogLines(t *testing.T) {
	logsPath := filepath.Join(t.TempDir(), "jasper.log")
	if err := os.WriteFile(logsPath, []byte(
		`{"level":"ERROR","msg":"migration failed","name":"004_mcp_grants.sql"}`+"\n"), 0o600); err != nil {
		t.Fatalf("seed log: %v", err)
	}

	data := buildUnrecoverableData(logsPath)
	if !strings.Contains(data.LogExcerpt, "004_mcp_grants.sql") {
		t.Fatalf("LogExcerpt did not tail the log: %q", data.LogExcerpt)
	}

	rr := httptest.NewRecorder()
	newBootErrorHandler("unrecoverable.html", data).
		ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))

	if body := rr.Body.String(); !strings.Contains(body, "004_mcp_grants.sql") {
		t.Errorf("unrecoverable page rendered no log lines; got:\n%s", body)
	}
}

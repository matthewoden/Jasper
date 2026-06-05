package app

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestStartupErrorHandler_RootPath_ReturnsHTMLWithCopy — the root path
// (and any non-/api path) gets the rendered startup-error.html with
// the templated values substituted. Asserts:
//   - status 500
//   - Content-Type starts with text/html
//   - body contains the locked headline ("Jasper couldn't start")
//   - body contains the locked footer copy
//   - body contains each substituted field (PhaseName, ErrorSummary,
//     SuggestedAction, LogExcerpt)
func TestStartupErrorHandler_RootPath_ReturnsHTMLWithCopy(t *testing.T) {
	h := newStartupErrorHandler(StartupErrorData{
		PhaseName:       "Migration 004_mcp_grants.sql",
		ErrorSummary:    "syntax error near GRANTS",
		SuggestedAction: "Run jasper doctor",
		LogExcerpt:      "2026-05-17 14:32 migrate run started\n2026-05-17 14:32 ERROR: syntax error near GRANTS",
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Errorf("status: got %d, want 500", rr.Code)
	}
	ct := rr.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type: got %q, want text/html*", ct)
	}
	body := rr.Body.String()
	wantSubs := []string{
		"Jasper couldn",
		"start",
		"Migration 004_mcp_grants.sql",
		"syntax error near GRANTS",
		"Run jasper doctor",
		"2026-05-17 14:32 migrate run started",
		"Powered by Jasper. This page is static",
	}
	for _, s := range wantSubs {
		if !strings.Contains(body, s) {
			t.Errorf("body missing %q; got:\n%s", s, body)
		}
	}
}

// TestStartupErrorHandler_APIPath_ReturnsJSON — a request to /api/v1/...
// returns a JSON 503 envelope so the client can parse it.
func TestStartupErrorHandler_APIPath_ReturnsJSON(t *testing.T) {
	h := newStartupErrorHandler(StartupErrorData{
		PhaseName:    "Index rebuild",
		ErrorSummary: "could not open notes dir",
	})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/notes", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusServiceUnavailable {
		t.Errorf("status: got %d, want 503", rr.Code)
	}
	ct := rr.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type: got %q, want application/json*", ct)
	}
	body := rr.Body.String()
	if !strings.Contains(body, `"code":"startup_failed"`) {
		t.Errorf("body did not contain code=startup_failed: %s", body)
	}
}

// TestStartupErrorHandler_NoCache — every response sets Cache-Control:
// no-store so a browser tab does not cache the error page.
func TestStartupErrorHandler_NoCache(t *testing.T) {
	h := newStartupErrorHandler(StartupErrorData{})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if got := rr.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control: got %q, want no-store", got)
	}
}

// TestStartupErrorHandler_XSSGuard — the four template fields must be
// auto-escaped by html/template. An injected <script> tag in
// ErrorSummary must appear as &lt;script&gt; in the rendered body,
// never as a literal <script>. This is the load-bearing security
// invariant per UI-SPEC §Forward-Compatibility Assert #1 + threat T-08-12.
func TestStartupErrorHandler_XSSGuard(t *testing.T) {
	h := newStartupErrorHandler(StartupErrorData{
		PhaseName:       "Migration",
		ErrorSummary:    "<script>alert(1)</script>",
		SuggestedAction: "Run jasper doctor",
		LogExcerpt:      "<script>steal()</script>",
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	body := rr.Body.String()

	if !strings.Contains(body, "&lt;script&gt;") {
		t.Errorf("body did not contain escaped &lt;script&gt;; got:\n%s", body)
	}

	if strings.Contains(body, "<script>alert(1)") || strings.Contains(body, "<script>steal()") {
		t.Errorf("XSS guard breached: literal <script> payload appeared in body:\n%s", body)
	}
}

// TestStartupErrorHandler_NoScriptTags — UI-SPEC §Forward-Compatibility
// Assert #1: the rendered HTML body must contain zero `<script` substrings.
// This is the CSP-bypass guard (T-08-15 mitigation).
func TestStartupErrorHandler_NoScriptTags(t *testing.T) {
	h := newStartupErrorHandler(StartupErrorData{
		PhaseName:       "Migration",
		ErrorSummary:    "some error",
		SuggestedAction: "Run jasper doctor",
		LogExcerpt:      "log line one\nlog line two",
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	body := rr.Body.String()
	if strings.Contains(body, "<script") {
		t.Errorf("body contained <script substring (Forward-Compat #1 violated):\n%s", body)
	}
}

// TestStartupErrorHandler_NoExternalResources — UI-SPEC §Forward-Compat
// Assert #2: the rendered HTML body must not reference any external
// resource (no http://, https://, <link, <img). The template inlines
// the CSS and embeds no images.
func TestStartupErrorHandler_NoExternalResources(t *testing.T) {
	h := newStartupErrorHandler(StartupErrorData{
		PhaseName:       "Migration",
		ErrorSummary:    "boom",
		SuggestedAction: "Run jasper doctor",
		LogExcerpt:      "log",
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	body := rr.Body.String()
	forbidden := []string{
		"http://",
		"https://",
		"<link",
		"<img",
	}
	for _, s := range forbidden {
		if strings.Contains(body, s) {
			t.Errorf("body contained forbidden external-resource marker %q (Forward-Compat #2 violated):\n%s", s, body)
		}
	}
}

// TestSuggestedActionFor — coarse mapping (D-11): error class → one of
// three legal user-facing suggestion strings.
func TestSuggestedActionFor(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"nil error", nil, "Restore from your most recent backup"},
		{"migration error", errors.New("migrate run: failed to apply 003_fts.sql"), "Run jasper doctor"},
		{"sql syntax error", errors.New("SQL syntax error near GRANTS"), "Run jasper doctor"},
		{"disk-related error", errors.New("could not write: no disk space"), "Free up disk space and retry"},
		{"unknown error", errors.New("something else broke"), "Restore from your most recent backup"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := suggestedActionFor(tc.err)
			if got != tc.want {
				t.Errorf("suggestedActionFor(%v): got %q, want %q", tc.err, got, tc.want)
			}
		})
	}
}

// TestTailLog_MissingFile — when the log file does not exist, tailLog
// returns a friendly placeholder rather than an error.
func TestTailLog_MissingFile(t *testing.T) {
	got := tailLog("/nonexistent/path/jasper.log", 20)
	if got != "(no log file yet)" {
		t.Errorf("tailLog missing: got %q, want %q", got, "(no log file yet)")
	}
}

// TestTailLog_EmptyPath — when no path is provided, tailLog returns a
// friendly placeholder rather than attempting to open "".
func TestTailLog_EmptyPath(t *testing.T) {
	got := tailLog("", 20)
	if got != "(no log file path configured)" {
		t.Errorf("tailLog empty path: got %q", got)
	}
}

// TestTailLog_LastNLines — tailLog returns the last N lines of a small
// log file. Writes a known set of lines, asks for the last 3, asserts
// the slice.
func TestTailLog_LastNLines(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "jasper.log")
	content := "line 1\nline 2\nline 3\nline 4\nline 5\n"
	if err := os.WriteFile(logPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write log: %v", err)
	}
	got := tailLog(logPath, 3)
	want := "line 3\nline 4\nline 5"
	if got != want {
		t.Errorf("tailLog last 3: got %q, want %q", got, want)
	}
}

// TestTailLog_HugeFile_Capped — tailLog caps the read at 16 KiB; a
// 64 KiB file's tail-3-lines call should succeed quickly and return
// three lines from somewhere in the last 16 KiB (T-08-14 mitigation).
func TestTailLog_HugeFile_Capped(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "huge.log")

	var sb strings.Builder
	for sb.Len() < 64*1024 {
		sb.WriteString("ab\n")
	}
	if err := os.WriteFile(logPath, []byte(sb.String()), 0o644); err != nil {
		t.Fatalf("write huge log: %v", err)
	}
	got := tailLog(logPath, 3)
	lines := strings.Split(got, "\n")
	if len(lines) != 3 {
		t.Errorf("tailLog huge file: got %d lines, want 3 — output:\n%s", len(lines), got)
	}
	for i, ln := range lines {
		if ln != "ab" {
			t.Errorf("tailLog huge file line %d: got %q, want %q", i, ln, "ab")
		}
	}
}

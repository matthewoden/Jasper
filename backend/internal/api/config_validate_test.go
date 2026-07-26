package api

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

func setupValidateServer(t *testing.T) *httptest.Server {
	t.Helper()
	t.Setenv("JASPER_APP_HOME", t.TempDir())
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, vault.SubdirName), 0o755); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServerWithIndex(nil, nil, nil, nil, nil, logger, dir)
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(ConfigStrictBodyMiddleware)
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r)
}

// validConfigBody returns a minimal valid PUT /config body for testing.
// autosaveMs is injected as the specified value.
func validConfigBodyWithAutosave(autosaveMs int) []byte {
	body := []byte(`{
		"appName":"Jasper","theme":"dark",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":` +
		itoa(autosaveMs) + `}
	}`)
	return body
}

// itoa avoids importing "strconv" at the package level.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	pos := len(buf)
	for n > 0 {
		pos--
		buf[pos] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

// TestConfigMiddleware_AutosaveMs — autosaveMs range validation:
// 249 → 400, 250 → 200, 10000 → 200, 10001 → 400.
func TestConfigMiddleware_AutosaveMs(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	tests := []struct {
		autosaveMs int
		wantStatus int
	}{
		{249, 400},
		{250, 200},
		{10000, 200},
		{10001, 400},
	}

	for _, tc := range tests {
		body := validConfigBodyWithAutosave(tc.autosaveMs)
		req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("autosaveMs=%d: request error: %v", tc.autosaveMs, err)
		}
		respBody, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != tc.wantStatus {
			t.Errorf("autosaveMs=%d: got %d, want %d; body=%s",
				tc.autosaveMs, resp.StatusCode, tc.wantStatus, respBody)
		}
	}
}

// TestConfigMiddleware_DisplayNameField_Rejected400 — D-05: display_name is
// deleted from the Config schema; the strictConfigValidator no longer
// declares it, so any body carrying the legacy key is rejected as an
// unknown field.
func TestConfigMiddleware_DisplayNameField_Rejected400(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName":"Jasper","theme":"dark",
		"display_name":"My Notes",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":2000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("display_name field: got %d, want 400 (unknown field); body=%s", resp.StatusCode, respBody)
	}
}

// TestConfigMiddleware_ServerBindAccepted — a body carrying server.bind must NOT
// be rejected as an unknown field. The Settings panel round-trips the full
// config including server.bind, so the strict validator must recognize it.
func TestConfigMiddleware_ServerBindAccepted(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName":"Jasper","theme":"dark",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":2000},
		"server":{"port":6683,"dataDir":"/tmp/x","bind":"0.0.0.0"}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode == 400 {
		t.Errorf("server.bind rejected as unknown field: got 400; body=%s", respBody)
	}
}

// TestConfigStrictBody_AcceptsAllV14Fields — a PUT body carrying every new
// D-17 field (templates.folder, editor.{showProperties,autoPair,foldGutter,
// lineNumbers,lineWidth}, mcp.auditLog) alongside the existing required
// fields must pass the strict-body middleware (no 400).
func TestConfigStrictBody_AcceptsAllV14Fields(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName":"Jasper","theme":"dark",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{
			"fontSize":15,"lineHeight":1.6,"autosaveMs":2000,
			"showProperties":false,"autoPair":false,"foldGutter":false,
			"lineNumbers":true,"lineWidth":900
		},
		"mcp":{"port":6684,"bind":"127.0.0.1","auditLog":true},
		"templates":{"folder":"MyTemplates"}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode == 400 {
		t.Errorf("v1.4 fields rejected: got 400; body=%s", respBody)
	}
}

// TestConfigStrictBody_RejectsLineWidthOutOfRange — editor.lineWidth outside
// the 400-2000 range must be rejected with 400 invalid_request.
func TestConfigStrictBody_RejectsLineWidthOutOfRange(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName":"Jasper","theme":"dark",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":2000,"lineWidth":3000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("lineWidth=3000: got %d, want 400; body=%s", resp.StatusCode, respBody)
	}
	if !bytes.Contains(respBody, []byte(`"invalid_request"`)) {
		t.Errorf("lineWidth=3000: body missing invalid_request code; body=%s", respBody)
	}
}

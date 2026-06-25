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
		"editor":{"fontSize":15,"lineHeight":1.6,"vimMode":false,"autosaveMs":` +
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

// TestConfigMiddleware_DisplayName_TooLong — display_name > 64 chars → 400.
func TestConfigMiddleware_DisplayName_TooLong(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	long65 := `"` + string(make([]byte, 65)) + `"` // 65 bytes of null chars is > 64
	_ = long65
	// Use a real 65-character string:
	name65 := "A"
	for i := 1; i < 65; i++ {
		name65 += "A"
	}

	body := []byte(`{
		"appName":"Jasper","theme":"dark",
		"display_name":"` + name65 + `",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"vimMode":false,"autosaveMs":2000}
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
		t.Errorf("display_name 65 chars: got %d, want 400; body=%s", resp.StatusCode, respBody)
	}
}

// TestConfigMiddleware_ServerBindAccepted — a body carrying server.bind must
// NOT be rejected as an unknown field. Regression guard for the strict
// validator missing the server.bind key (NET-01): the Settings NETWORK section
// round-trips the full config including server.bind, so DisallowUnknownFields
// must recognize it.
func TestConfigMiddleware_ServerBindAccepted(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName":"Jasper","theme":"dark",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"vimMode":false,"autosaveMs":2000},
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

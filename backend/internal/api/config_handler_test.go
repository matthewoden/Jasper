package api

import (
	"bytes"
	"encoding/json"
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

func setupConfigServer(t *testing.T) (*httptest.Server, string) {
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
	return httptest.NewServer(r), dir
}

func TestGetConfig_DefaultsOnFirstRun(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/config")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var got Config
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if string(got.Theme) != "dark" {
		t.Errorf("Theme: got %q, want %q", got.Theme, "dark")
	}
	if got.AppName != "Jasper" {
		t.Errorf("AppName: got %q, want %q", got.AppName, "Jasper")
	}
}

func TestPutConfig_RoundTrip(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName": "Jasper",
		"theme": "light",
		"dailyNotes": {"folder": "daily", "template": ""},
		"editor": {"fontSize": 16, "lineHeight": 1.7, "vimMode": false, "autosaveMs": 2000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	putBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body: %s", resp.StatusCode, string(putBody))
	}
	var echoed Config
	if err := json.Unmarshal(putBody, &echoed); err != nil {
		t.Fatal(err)
	}
	// The PUT response echoes the submitted config before D-02 load-coercion,
	// so the written value ("light") is reflected here verbatim.
	if string(echoed.Theme) != "light" {
		t.Errorf("Theme: got %q, want %q", echoed.Theme, "light")
	}

	resp2, err := http.Get(ts.URL + "/api/v1/config")
	if err != nil {
		t.Fatal(err)
	}
	getBody, _ := io.ReadAll(resp2.Body)
	_ = resp2.Body.Close()
	var got Config
	if err := json.Unmarshal(getBody, &got); err != nil {
		t.Fatal(err)
	}
	// GET reloads through config.Load, which under D-02 (Phase 17) pins Theme to
	// "dark" regardless of the persisted value — so the effective theme is dark.
	if string(got.Theme) != "dark" {
		t.Errorf("after GET — Theme: got %q, want %q", got.Theme, "dark")
	}
}

func TestPutConfig_UnknownField_400(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName": "Jasper", "theme": "dark", "dailyNotes": {"folder": "daily", "template": ""},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "vimMode": false, "autosaveMs": 2000},
		"unknownField": 42
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	unkBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("unknown field: got %d, want 400; body: %s", resp.StatusCode, string(unkBody))
	}
}

func TestPutConfig_ThemeEnum_400(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName": "Jasper", "theme": "neon-purple",
		"dailyNotes": {"folder": "daily", "template": ""},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "vimMode": false, "autosaveMs": 2000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("invalid enum: got %d, want 400", resp.StatusCode)
	}
}

// TestPutConfig_DisplayName — PUT a config with display_name; the response
// and a subsequent GET must both return it.
func TestPutConfig_DisplayName(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName": "Jasper", "theme": "dark",
		"display_name": "My Notes",
		"dailyNotes": {"folder": "daily", "template": ""},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "vimMode": false, "autosaveMs": 2000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	putBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("PUT status: got %d, want 200; body: %s", resp.StatusCode, putBody)
	}
	var echoed Config
	if err := json.Unmarshal(putBody, &echoed); err != nil {
		t.Fatalf("PUT response unmarshal: %v", err)
	}
	if echoed.DisplayName == nil || *echoed.DisplayName != "My Notes" {
		t.Errorf("PUT response: DisplayName = %v, want \"My Notes\"", echoed.DisplayName)
	}

	resp2, err := http.Get(ts.URL + "/api/v1/config")
	if err != nil {
		t.Fatal(err)
	}
	getBody, _ := io.ReadAll(resp2.Body)
	_ = resp2.Body.Close()
	var got Config
	if err := json.Unmarshal(getBody, &got); err != nil {
		t.Fatalf("GET response unmarshal: %v", err)
	}
	if got.DisplayName == nil || *got.DisplayName != "My Notes" {
		t.Errorf("GET after PUT: DisplayName = %v, want \"My Notes\"", got.DisplayName)
	}
}

// TestLineHeightRoundTrip_Precision — toWireConfig / fromWireConfig must
// preserve float64 precision for lineHeight: 1.6 must come back as exactly
// 1.6, not the float32-truncated 1.5999999046325684.
func TestLineHeightRoundTrip_Precision(t *testing.T) {
	t.Parallel()
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName": "Jasper",
		"theme": "dark",
		"dailyNotes": {"folder": "daily", "template": ""},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "vimMode": false, "autosaveMs": 2000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	putBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("PUT status: got %d, want 200; body: %s", resp.StatusCode, putBody)
	}

	// GET after PUT — lineHeight must be exactly 1.6 (float64 precision)
	resp2, err := http.Get(ts.URL + "/api/v1/config")
	if err != nil {
		t.Fatal(err)
	}
	getBody, _ := io.ReadAll(resp2.Body)
	_ = resp2.Body.Close()

	// Decode into a generic map to inspect the raw JSON number without struct
	// truncation — this is what the wire actually sends.
	var got Config
	if err := json.Unmarshal(getBody, &got); err != nil {
		t.Fatalf("GET response unmarshal: %v", err)
	}
	const want = 1.6
	if got.Editor.LineHeight != want {
		t.Errorf("lineHeight round-trip precision: got %v, want %v (CR-01 float32 truncation)", got.Editor.LineHeight, want)
	}
}

// TestPutConfig_PreservesUnknownFields — a PUT must preserve an unmanaged
// key that was already on disk (merge-on-write).
func TestPutConfig_PreservesUnknownFields(t *testing.T) {
	ts, dir := setupConfigServer(t)
	defer ts.Close()

	configPath := filepath.Join(dir, ".jasper", "config.json")
	seed := []byte(`{
		"appName":"Jasper","theme":"dark",
		"_jasper_unmanaged":"preserve-me",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"vimMode":false,"autosaveMs":2000},
		"server":{"port":6683,"dataDir":""},
		"mcp":{"enabled":true,"port":6684,"bind":"127.0.0.1"}
	}`)
	if err := os.WriteFile(configPath, seed, 0o644); err != nil {
		t.Fatal(err)
	}

	body := []byte(`{
		"appName": "Jasper", "theme": "light",
		"dailyNotes": {"folder": "daily", "template": ""},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "vimMode": false, "autosaveMs": 2000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("PUT status: got %d, want 200; body: %s", resp.StatusCode, respBody)
	}

	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var onDisk map[string]json.RawMessage
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("unmarshal disk: %v", err)
	}
	val, ok := onDisk["_jasper_unmanaged"]
	if !ok {
		t.Error("unmanaged key '_jasper_unmanaged' was dropped by PUT (D-09 regression)")
	} else {
		var s string
		if err := json.Unmarshal(val, &s); err != nil || s != "preserve-me" {
			t.Errorf("unmanaged key value: got %s, want \"preserve-me\"", val)
		}
	}

	theme, ok := onDisk["theme"]
	if !ok {
		t.Error("theme key missing after PUT")
	} else {
		var themeStr string
		if err := json.Unmarshal(theme, &themeStr); err != nil || themeStr != "light" {
			t.Errorf("theme: got %s, want \"light\"", theme)
		}
	}
}

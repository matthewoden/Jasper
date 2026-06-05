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
)

func setupConfigServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "storage"), 0o755); err != nil {
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
		"editor": {"fontSize": 16, "lineHeight": 1.7, "vimMode": false}
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
	if string(got.Theme) != "light" {
		t.Errorf("after GET — Theme: got %q, want %q", got.Theme, "light")
	}
}

func TestPutConfig_UnknownField_400(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName": "Jasper", "theme": "dark", "dailyNotes": {"folder": "daily", "template": ""},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "vimMode": false},
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
		"editor": {"fontSize": 15, "lineHeight": 1.6, "vimMode": false}
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

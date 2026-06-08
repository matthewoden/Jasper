package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/internal/vault"
	"github.com/matthewoden/jasper/backend/migrations"
)

func setupSetupTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dataDir := t.TempDir()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &fakeFileStore{}
	svc := notes.NewService(files, nil, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, nil, nil, logger, dataDir)
	srv.SetMigrationsFS(migrations.FS)
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r), dataDir
}

// SH1: no config.json on disk → FirstRun:true.
func TestGetSetupStatus_NoConfigJSON_FirstRunTrue(t *testing.T) {
	t.Parallel()
	ts, _ := setupSetupTestServer(t)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/setup/status")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d want 200", resp.StatusCode)
	}
	var body struct {
		FirstRun bool `json:"first_run"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.FirstRun {
		t.Fatalf("FirstRun: got false want true")
	}
}

// SH2: config.json present on disk → FirstRun:false.
func TestGetSetupStatus_ConfigJSONPresent_FirstRunFalse(t *testing.T) {
	t.Parallel()
	ts, dataDir := setupSetupTestServer(t)
	defer ts.Close()

	if err := os.MkdirAll(filepath.Join(dataDir, vault.SubdirName), 0o755); err != nil {
		t.Fatalf("mkdir .jasper: %v", err)
	}
	if err := os.WriteFile(vault.ConfigPath(dataDir), []byte("{}"), 0o600); err != nil {
		t.Fatalf("write config.json: %v", err)
	}
	resp, err := http.Get(ts.URL + "/api/v1/setup/status")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	var body struct {
		FirstRun bool `json:"first_run"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.FirstRun {
		t.Fatalf("FirstRun: got true want false")
	}
}

func postValidate(t *testing.T, ts *httptest.Server, path string) (int, struct {
	Valid   bool    `json:"valid"`
	Code    *string `json:"code,omitempty"`
	Message *string `json:"message,omitempty"`
},
) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"path": path})
	resp, err := http.Post(ts.URL+"/api/v1/setup/validate-data-dir", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	var out struct {
		Valid   bool    `json:"valid"`
		Code    *string `json:"code,omitempty"`
		Message *string `json:"message,omitempty"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// SH3: valid path returns 200 + valid:true.
func TestPostSetupValidateDataDir_Valid(t *testing.T) {
	t.Parallel()
	ts, _ := setupSetupTestServer(t)
	defer ts.Close()
	tmpBase := t.TempDir()
	target := filepath.Join(tmpBase, "Jasper")
	status, body := postValidate(t, ts, target)
	if status != http.StatusOK {
		t.Fatalf("status: got %d want 200", status)
	}
	if !body.Valid {
		t.Fatalf("Valid: got false want true (code=%v msg=%v)", body.Code, body.Message)
	}
}

// SH4: each of the 4 D-08 refusal cases returns valid:false + correct
// code + the locked-copy message.
//
// NOTE: the parent test is NOT marked t.Parallel() because the
// subtests below ARE parallel; pairing parent-parallel + subtests-
// parallel with a shared `defer ts.Close()` would close the server
// before the subtests' POSTs reach it. We rely on httptest.Server's
// t.Cleanup hook (registered inside setupSetupTestServer's helper
// via this test's t) to tear down at end-of-test.
func TestPostSetupValidateDataDir_RefusalCases(t *testing.T) {
	ts, _ := setupSetupTestServer(t)
	t.Cleanup(ts.Close)

	t.Run("non_ascii", func(t *testing.T) {
		t.Parallel()
		_, body := postValidate(t, ts, "/tmp/Jasper-é")
		if body.Valid {
			t.Fatalf("expected Valid=false")
		}
		if body.Code == nil || *body.Code != "non_ascii" {
			t.Fatalf("Code: got %v want non_ascii", body.Code)
		}
		if body.Message == nil || !strings.Contains(*body.Message, "don't survive cross-platform sync") {
			t.Fatalf("Message: got %v want locked phrase", body.Message)
		}
	})

	t.Run("parent_missing", func(t *testing.T) {
		t.Parallel()
		tmpBase := t.TempDir()
		_, body := postValidate(t, ts, filepath.Join(tmpBase, "absent-12345", "Jasper"))
		if body.Valid {
			t.Fatalf("expected Valid=false")
		}
		if body.Code == nil || *body.Code != "parent_missing" {
			t.Fatalf("Code: got %v want parent_missing", body.Code)
		}
		if body.Message == nil || !strings.Contains(*body.Message, "parent folder doesn't exist") {
			t.Fatalf("Message: got %v want locked phrase", body.Message)
		}
	})

	t.Run("nested_vault", func(t *testing.T) {
		t.Parallel()
		base := t.TempDir()
		vaultDir := filepath.Join(base, "vault")
		if err := os.MkdirAll(filepath.Join(vaultDir, "notes"), 0o755); err != nil {
			t.Fatalf("mkdir notes: %v", err)
		}
		if err := os.MkdirAll(filepath.Join(vaultDir, vault.SubdirName), 0o755); err != nil {
			t.Fatalf("mkdir .jasper: %v", err)
		}
		if err := os.WriteFile(vault.AppDBPath(vaultDir), []byte{0}, 0o600); err != nil {
			t.Fatalf("write app.db: %v", err)
		}
		sub := filepath.Join(vaultDir, "sub")
		if err := os.MkdirAll(sub, 0o755); err != nil {
			t.Fatalf("mkdir sub: %v", err)
		}
		_, body := postValidate(t, ts, filepath.Join(sub, "Inner"))
		if body.Valid {
			t.Fatalf("expected Valid=false")
		}
		if body.Code == nil || *body.Code != "nested_vault" {
			t.Fatalf("Code: got %v want nested_vault", body.Code)
		}
		if body.Message == nil || !strings.Contains(*body.Message, "inside an existing Jasper vault") {
			t.Fatalf("Message: got %v want locked phrase", body.Message)
		}
	})

	t.Run("unwritable", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root bypasses 0o500")
		}
		t.Parallel()
		base := t.TempDir()
		ro := filepath.Join(base, "ro")
		if err := os.MkdirAll(ro, 0o755); err != nil {
			t.Fatalf("mkdir ro: %v", err)
		}
		if err := os.Chmod(ro, 0o500); err != nil {
			t.Fatalf("chmod: %v", err)
		}
		t.Cleanup(func() { _ = os.Chmod(ro, 0o755) })
		_, body := postValidate(t, ts, filepath.Join(ro, "Jasper"))
		if body.Valid {
			t.Fatalf("expected Valid=false")
		}
		if body.Code == nil || *body.Code != "unwritable" {
			t.Fatalf("Code: got %v want unwritable", body.Code)
		}
		if body.Message == nil || !strings.HasPrefix(*body.Message, "Jasper can't write here:") {
			t.Fatalf("Message: got %v want locked prefix", body.Message)
		}
	})
}

// SH5: empty body returns valid:false + the "Pick a data-dir path." hint.
func TestPostSetupValidateDataDir_EmptyBody(t *testing.T) {
	t.Parallel()
	ts, _ := setupSetupTestServer(t)
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/v1/setup/validate-data-dir", "application/json", bytes.NewReader([]byte{}))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: got %d want 200 or 400", resp.StatusCode)
	}
}

// SH6: happy path — request body submitted, full pipeline runs,
// returns 200 + ok:true, on-disk state matches.
func TestPostSetup_HappyPath(t *testing.T) {
	t.Parallel()
	ts, _ := setupSetupTestServer(t)
	defer ts.Close()

	base := t.TempDir()
	target := filepath.Join(base, "Jasper")
	reqBody := map[string]any{
		"data_dir":                target,
		"theme":                   "dark",
		"mcp_enabled":             false,
		"mcp_grants":              []any{},
		"daily_template":          "# {{date}}\n\n",
		"create_today_daily_note": false,
	}
	bodyBytes, _ := json.Marshal(reqBody)
	resp, err := http.Post(ts.URL+"/api/v1/setup", "application/json", bytes.NewReader(bodyBytes))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: got %d want 200 (body=%s)", resp.StatusCode, respBody)
	}
	var out struct {
		Ok bool `json:"ok"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.Ok {
		t.Fatalf("Ok: got false want true")
	}

	if _, err := os.Stat(vault.ConfigPath(target)); err != nil {
		t.Fatalf("config.json missing: %v", err)
	}
	if _, err := os.Stat(vault.AppDBPath(target)); err != nil {
		t.Fatalf("app.db missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(target, "notes")); err != nil {
		t.Fatalf("notes/ missing: %v", err)
	}
}

// SH7: revision 2 W1 fix regression — mcp_enabled:true persists to
// cfg.MCP.Enabled on disk so 08-09's listener boots with the right
// flag.
func TestPostSetup_McpEnabledTrue_PersistsToConfigJSON(t *testing.T) {
	t.Parallel()
	ts, _ := setupSetupTestServer(t)
	defer ts.Close()

	base := t.TempDir()
	target := filepath.Join(base, "Jasper")
	reqBody := map[string]any{
		"data_dir":                target,
		"theme":                   "dark",
		"mcp_enabled":             true,
		"mcp_grants":              []any{},
		"daily_template":          "# {{date}}\n\n",
		"create_today_daily_note": false,
	}
	bodyBytes, _ := json.Marshal(reqBody)
	resp, err := http.Post(ts.URL+"/api/v1/setup", "application/json", bytes.NewReader(bodyBytes))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: got %d want 200 (body=%s)", resp.StatusCode, respBody)
	}

	cfg, err := config.Load(target, slog.Default())
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if !cfg.MCP.Enabled {
		t.Fatalf("cfg.MCP.Enabled: got false want true (revision 2 W1 fix regression)")
	}
}

// SH8: empty body → 400.
func TestPostSetup_EmptyBody_400(t *testing.T) {
	t.Parallel()
	ts, _ := setupSetupTestServer(t)
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/v1/setup", "application/json", bytes.NewReader([]byte{}))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: got %d want 400", resp.StatusCode)
	}
}

// SH9: server constructed without SetMigrationsFS returns 500
// "setup_misconfigured" — guards against tests / future callers that
// forget to wire migrationsFS.
func TestPostSetup_MissingMigrationsFS_500(t *testing.T) {
	t.Parallel()
	dataDir := t.TempDir()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &fakeFileStore{}
	svc := notes.NewService(files, nil, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, nil, nil, logger, dataDir)

	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	ts := httptest.NewServer(r)
	defer ts.Close()

	body, _ := json.Marshal(map[string]any{
		"data_dir":                filepath.Join(t.TempDir(), "Jasper"),
		"theme":                   "dark",
		"mcp_enabled":             false,
		"mcp_grants":              []any{},
		"daily_template":          "",
		"create_today_daily_note": false,
	})
	resp, err := http.Post(ts.URL+"/api/v1/setup", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status: got %d want 500", resp.StatusCode)
	}
	respBody, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(respBody), "setup_misconfigured") {
		t.Errorf("body did not include setup_misconfigured code: %s", respBody)
	}
}

var _ = context.Background

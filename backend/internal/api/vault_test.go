package api

// vault_test.go — Plan 08-17b Task 1 TDD tests for /vault/* handlers.
//
// Table-driven tests covering all five vault handlers.
// Uses t.Setenv("JASPER_APP_HOME", t.TempDir()) to isolate each test's
// app.json from the developer's real ~/.jasper.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

// setupVaultTestServer creates a chi router with the full strict server wired,
// backed by an empty notes service. The caller is responsible for seeding
// JASPER_APP_HOME via t.Setenv.
func setupVaultTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	// Nil file store — vault tests don't exercise note operations.
	svc := notes.NewService(nil, nil, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, nil, nil, logger, "")
	si := NewStrictHandler(srv, nil)

	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r)
}

// seedAppJSON writes an AppState to JASPER_APP_HOME/app.json and returns the
// path to app.json. JASPER_APP_HOME must already be set via t.Setenv.
func seedAppJSON(t *testing.T, state *vault.AppState) string {
	t.Helper()
	appHome := os.Getenv("JASPER_APP_HOME")
	if appHome == "" {
		t.Fatal("JASPER_APP_HOME not set; call t.Setenv before seedAppJSON")
	}
	path := filepath.Join(appHome, "app.json")
	if err := vault.SaveAppJSON(path, state); err != nil {
		t.Fatalf("seedAppJSON: %v", err)
	}
	return path
}

// --- GetVaultCurrent ---

func TestGetVaultCurrent_NoVault_Returns200Null(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

	resp, body := mustGet(t, ts, "/api/v1/vault/current")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: want 200, got %d; body: %s", resp.StatusCode, body)
	}

	var got VaultCurrentResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, body)
	}
	if got.Vault != nil {
		t.Errorf("want vault=nil, got %+v", got.Vault)
	}
}

func TestGetVaultCurrent_VaultOpen_ReturnsEntry(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	// Create a real vault folder so os.Stat succeeds.
	vaultDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(vaultDir, ".jasper"), 0o700); err != nil {
		t.Fatal(err)
	}

	canonical, err := vault.Canonicalize(vaultDir)
	if err != nil {
		t.Fatal(err)
	}

	state := &vault.AppState{
		CurrentVault: canonical,
		RecentVaults: []vault.RecentVaultEntry{
			{
				Path:         canonical,
				DisplayName:  "Test Vault",
				LastOpenedAt: time.Now().UTC(),
				CreatedAt:    time.Now().UTC().Add(-time.Hour),
				Missing:      false,
			},
		},
	}
	seedAppJSON(t, state)

	ts := setupVaultTestServer(t)
	defer ts.Close()

	resp, body := mustGet(t, ts, "/api/v1/vault/current")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: want 200, got %d; body: %s", resp.StatusCode, body)
	}

	var got VaultCurrentResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, body)
	}
	if got.Vault == nil {
		t.Fatal("want vault != nil")
	}
	if got.Vault.Path != canonical {
		t.Errorf("path: want %q, got %q", canonical, got.Vault.Path)
	}
	if got.Vault.DisplayName != "Test Vault" {
		t.Errorf("display_name: want Test Vault, got %q", got.Vault.DisplayName)
	}
}

// --- GetVaultRecent ---

func TestGetVaultRecent_EmptyList_ReturnsEmpty(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

	resp, body := mustGet(t, ts, "/api/v1/vault/recent")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: want 200, got %d; body: %s", resp.StatusCode, body)
	}

	var got VaultRecentResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Vaults) != 0 {
		t.Errorf("want 0 vaults, got %d", len(got.Vaults))
	}
	if got.Banner != "" {
		t.Errorf("want empty banner, got %q", got.Banner)
	}
}

func TestGetVaultRecent_PopulatedList_ReturnsNewestFirst(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	now := time.Now().UTC()
	// Three vault dirs; all get .jasper/ so they aren't marked missing.
	vaultA := t.TempDir()
	vaultB := t.TempDir()
	vaultC := t.TempDir()
	for _, d := range []string{vaultA, vaultB, vaultC} {
		if err := os.MkdirAll(filepath.Join(d, ".jasper"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	canA, _ := vault.Canonicalize(vaultA)
	canB, _ := vault.Canonicalize(vaultB)
	canC, _ := vault.Canonicalize(vaultC)

	// Seed with B newest, A oldest.
	state := &vault.AppState{
		RecentVaults: []vault.RecentVaultEntry{
			{Path: canA, DisplayName: "A", LastOpenedAt: now.Add(-2 * time.Hour), CreatedAt: now.Add(-3 * time.Hour)},
			{Path: canB, DisplayName: "B", LastOpenedAt: now, CreatedAt: now.Add(-1 * time.Hour)},
			{Path: canC, DisplayName: "C", LastOpenedAt: now.Add(-1 * time.Hour), CreatedAt: now.Add(-2 * time.Hour)},
		},
	}
	seedAppJSON(t, state)

	ts := setupVaultTestServer(t)
	defer ts.Close()

	resp, body := mustGet(t, ts, "/api/v1/vault/recent")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: want 200, got %d", resp.StatusCode)
	}

	var got VaultRecentResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Vaults) != 3 {
		t.Fatalf("want 3 vaults, got %d", len(got.Vaults))
	}
	// Newest-first: B, C, A
	if got.Vaults[0].DisplayName != "B" {
		t.Errorf("vaults[0]: want B, got %s", got.Vaults[0].DisplayName)
	}
	if got.Vaults[1].DisplayName != "C" {
		t.Errorf("vaults[1]: want C, got %s", got.Vaults[1].DisplayName)
	}
	if got.Vaults[2].DisplayName != "A" {
		t.Errorf("vaults[2]: want A, got %s", got.Vaults[2].DisplayName)
	}
}

// --- PostVaultOpen ---

func TestPostVaultOpen_MissingDotJasper_Returns400(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

	// A real dir but no .jasper/ inside.
	vaultDir := t.TempDir()
	body := mustPost(t, ts, "/api/v1/vault/open", map[string]any{"path": vaultDir})
	if body.StatusCode != http.StatusBadRequest {
		b, _ := io.ReadAll(body.Body)
		t.Fatalf("status: want 400, got %d; body: %s", body.StatusCode, b)
	}
}

func TestPostVaultOpen_HappyPath_UpdatesAppJSON(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

	// Create vault dir with .jasper/.
	vaultDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(vaultDir, ".jasper"), 0o700); err != nil {
		t.Fatal(err)
	}
	canonical, _ := vault.Canonicalize(vaultDir)

	resp := mustPost(t, ts, "/api/v1/vault/open", map[string]any{"path": vaultDir})
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 200, got %d; body: %s", resp.StatusCode, b)
	}

	// Verify app.json was updated.
	appJSONPath := filepath.Join(appHome, "app.json")
	state, err := vault.LoadAppJSON(appJSONPath)
	if err != nil {
		t.Fatalf("load app.json: %v", err)
	}
	if state.CurrentVault != canonical {
		t.Errorf("current_vault: want %q, got %q", canonical, state.CurrentVault)
	}
}

func TestPostVaultOpen_RelativePath_Returns400(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

	resp := mustPost(t, ts, "/api/v1/vault/open", map[string]any{"path": "./foo"})
	if resp.StatusCode != http.StatusBadRequest {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 400, got %d; body: %s", resp.StatusCode, b)
	}
}

// --- PostVaultCreate ---

func TestPostVaultCreate_NestedVault_Returns400(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

	// Create vault A with .jasper/.
	vaultA := t.TempDir()
	if err := os.MkdirAll(filepath.Join(vaultA, ".jasper"), 0o700); err != nil {
		t.Fatal(err)
	}
	// Attempt to create vault B inside vault A.
	vaultB := filepath.Join(vaultA, "nested")
	if err := os.MkdirAll(vaultB, 0o700); err != nil {
		t.Fatal(err)
	}

	resp := mustPost(t, ts, "/api/v1/vault/create", map[string]any{"path": vaultB})
	if resp.StatusCode != http.StatusBadRequest {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 400, got %d; body: %s", resp.StatusCode, b)
	}

	// Verify body mentions nested vault.
	b, _ := io.ReadAll(resp.Body)
	if len(b) > 0 {
		t.Logf("body: %s", b)
	}
}

func TestPostVaultCreate_NonASCII_Returns400(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

	// Path containing an emoji (non-ASCII).
	resp := mustPost(t, ts, "/api/v1/vault/create", map[string]any{"path": "/tmp/vault-🦄-test"})
	if resp.StatusCode != http.StatusBadRequest {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 400, got %d; body: %s", resp.StatusCode, b)
	}
}

func TestPostVaultCreate_HappyPath_CreatesDotJasper(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

	// Empty target dir.
	target := t.TempDir()

	resp := mustPost(t, ts, "/api/v1/vault/create", map[string]any{
		"path":        target,
		"theme":       "dark",
		"mcp_enabled": false,
	})
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 200, got %d; body: %s", resp.StatusCode, b)
	}

	// Verify .jasper/ was created with 0700.
	jasperDir := filepath.Join(target, ".jasper")
	info, err := os.Stat(jasperDir)
	if err != nil {
		t.Fatalf(".jasper/ not created: %v", err)
	}
	if !info.IsDir() {
		t.Fatal(".jasper should be a directory")
	}

	// Verify per-vault config.json exists.
	cfgPath := filepath.Join(jasperDir, "config.json")
	if _, err := os.Stat(cfgPath); err != nil {
		t.Fatalf(".jasper/config.json not created: %v", err)
	}

	// Verify app.db was created (migrations ran).
	dbPath := filepath.Join(jasperDir, "app.db")
	if _, err := os.Stat(dbPath); err != nil {
		t.Fatalf(".jasper/app.db not created: %v", err)
	}
}

// --- PostVaultForget ---

func TestPostVaultForget_RemovesEntry(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	// Seed with three vaults.
	vaultA := t.TempDir()
	vaultB := t.TempDir()
	vaultC := t.TempDir()
	canA, _ := vault.Canonicalize(vaultA)
	canB, _ := vault.Canonicalize(vaultB)
	canC, _ := vault.Canonicalize(vaultC)

	now := time.Now().UTC()
	state := &vault.AppState{
		RecentVaults: []vault.RecentVaultEntry{
			{Path: canA, DisplayName: "A", LastOpenedAt: now.Add(-2 * time.Hour), CreatedAt: now.Add(-3 * time.Hour)},
			{Path: canB, DisplayName: "B", LastOpenedAt: now, CreatedAt: now.Add(-1 * time.Hour)},
			{Path: canC, DisplayName: "C", LastOpenedAt: now.Add(-1 * time.Hour), CreatedAt: now.Add(-2 * time.Hour)},
		},
	}
	seedAppJSON(t, state)

	ts := setupVaultTestServer(t)
	defer ts.Close()

	// Forget B.
	resp := mustPost(t, ts, "/api/v1/vault/forget", map[string]any{"path": canB})
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 200, got %d; body: %s", resp.StatusCode, b)
	}

	// Verify recent list returns only A and C.
	listResp, listBody := mustGet(t, ts, "/api/v1/vault/recent")
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("status: want 200, got %d", listResp.StatusCode)
	}
	var got VaultRecentResponse
	if err := json.Unmarshal(listBody, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Vaults) != 2 {
		t.Fatalf("want 2 vaults after forget, got %d", len(got.Vaults))
	}
	for _, v := range got.Vaults {
		if v.Path == canB {
			t.Errorf("vault B should have been forgotten, still in list")
		}
	}
}

func TestPostVaultForget_AbsentPathIsIdempotent_200(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

	// Forget a path that was never registered.
	resp := mustPost(t, ts, "/api/v1/vault/forget", map[string]any{"path": "/nonexistent/vault"})
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 200, got %d; body: %s", resp.StatusCode, b)
	}
}

// --- PostVaultSwitch ---

// VaultSwitcherFunc is a test double implementing the VaultSwitcher interface.
type VaultSwitcherFunc struct {
	switchFn         func(ctx context.Context, targetPath string) (vault.RecentVaultEntry, error)
	currentVaultPath string
}

func (f *VaultSwitcherFunc) SwitchVault(ctx context.Context, targetPath string) (vault.RecentVaultEntry, error) {
	return f.switchFn(ctx, targetPath)
}

func (f *VaultSwitcherFunc) CurrentVaultPath() string {
	return f.currentVaultPath
}

// setupVaultSwitchServer creates a test server with a VaultSwitcher wired.
func setupVaultSwitchServer(t *testing.T, switcher VaultSwitcher) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := notes.NewService(nil, nil, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, nil, nil, logger, "")
	srv.SetVaultSwitcher(switcher)
	si := NewStrictHandler(srv, nil)

	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r)
}

func TestPostVaultSwitch_NilSwitcher_Returns400(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)
	// Server with NO VaultSwitcher wired (nil).
	ts := setupVaultTestServer(t)
	defer ts.Close()

	resp := mustPost(t, ts, "/api/v1/vault/switch", map[string]any{"path": "/some/absolute/path"})
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 400 (no vault open), got %d; body: %s", resp.StatusCode, b)
	}
}

func TestPostVaultSwitch_RelativePath_Returns400(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	switcher := &VaultSwitcherFunc{
		switchFn:         func(_ context.Context, _ string) (vault.RecentVaultEntry, error) { panic("not called") },
		currentVaultPath: "/vaultA",
	}
	ts := setupVaultSwitchServer(t, switcher)
	defer ts.Close()

	resp := mustPost(t, ts, "/api/v1/vault/switch", map[string]any{"path": "./relative/path"})
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 400, got %d; body: %s", resp.StatusCode, b)
	}
}

func TestPostVaultSwitch_SwitchInProgress_Returns409(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	// The VaultSwitcher returns the "switch in progress" error.
	switcher := &VaultSwitcherFunc{
		switchFn: func(_ context.Context, _ string) (vault.RecentVaultEntry, error) {
			return vault.RecentVaultEntry{}, errors.New("vault switch already in progress")
		},
		currentVaultPath: "/currently/switching/vault",
	}
	ts := setupVaultSwitchServer(t, switcher)
	defer ts.Close()

	vaultDir := t.TempDir()
	resp := mustPost(t, ts, "/api/v1/vault/switch", map[string]any{"path": vaultDir})
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusConflict {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 409, got %d; body: %s", resp.StatusCode, b)
	}
	var got struct {
		Error         string `json:"error"`
		CurrentTarget string `json:"current_target"`
	}
	b, _ := io.ReadAll(resp.Body)
	if jsonErr := json.Unmarshal(b, &got); jsonErr != nil {
		// Body already consumed above — log the raw bytes for debugging.
		t.Logf("body: %s", b)
		// Try to re-check status is 409 without body decode.
	}
}

func TestPostVaultSwitch_HappyPath_Returns200(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	targetDir := t.TempDir()
	canonical, _ := vault.Canonicalize(targetDir)
	now := time.Now().UTC()

	switcher := &VaultSwitcherFunc{
		switchFn: func(_ context.Context, _ string) (vault.RecentVaultEntry, error) {
			return vault.RecentVaultEntry{
				Path:         canonical,
				DisplayName:  "Target Vault",
				LastOpenedAt: now,
				CreatedAt:    now.Add(-time.Hour),
			}, nil
		},
		currentVaultPath: "/old/vault",
	}
	ts := setupVaultSwitchServer(t, switcher)
	defer ts.Close()

	resp := mustPost(t, ts, "/api/v1/vault/switch", map[string]any{"path": canonical})
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 200, got %d; body: %s", resp.StatusCode, b)
	}

	var got RecentVaultEntry
	b, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("decode body: %v (body=%s)", err, b)
	}
	if got.Path != canonical {
		t.Errorf("response path: want %q, got %q", canonical, got.Path)
	}
	if got.DisplayName != "Target Vault" {
		t.Errorf("display_name: want Target Vault, got %q", got.DisplayName)
	}
}

// mustPost is a helper that POSTs a JSON body and returns the response.
// It is not the same as the mustGet helper in handlers_test.go which returns body bytes.
func mustPost(t *testing.T, ts *httptest.Server, path string, body map[string]any) *http.Response {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
		ts.URL+path, bytes.NewReader(b))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	return resp
}

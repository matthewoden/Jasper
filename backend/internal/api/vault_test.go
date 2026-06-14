package api

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
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

func setupVaultTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	svc := notes.NewService(nil, nil, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, nil, nil, logger, "")
	si := NewStrictHandler(srv, nil)

	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r)
}

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

func TestPostVaultOpen_MissingDotJasper_Returns400(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

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

func TestPostVaultCreate_NestedVault_Returns400(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

	vaultA := t.TempDir()
	if err := os.MkdirAll(filepath.Join(vaultA, ".jasper"), 0o700); err != nil {
		t.Fatal(err)
	}

	vaultB := filepath.Join(vaultA, "nested")
	if err := os.MkdirAll(vaultB, 0o700); err != nil {
		t.Fatal(err)
	}

	resp := mustPost(t, ts, "/api/v1/vault/create", map[string]any{"path": vaultB})
	if resp.StatusCode != http.StatusBadRequest {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 400, got %d; body: %s", resp.StatusCode, b)
	}

	b, _ := io.ReadAll(resp.Body)
	if len(b) > 0 {
		t.Logf("body: %s", b)
	}
}

// Regression: ~/.jasper (the app-level registry directory) must not be
// mistaken for a vault marker, otherwise the user can't create their first
// vault under $HOME — every candidate trips the nested-vault check on its
// way up the ancestor walk.
func TestPostVaultCreate_AppHomeRegistry_DoesNotBlockSiblingVaults(t *testing.T) {
	fakeHome := t.TempDir()
	appHome := filepath.Join(fakeHome, ".jasper")
	if err := os.MkdirAll(appHome, 0o700); err != nil {
		t.Fatalf("seed app home: %v", err)
	}
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

	target := filepath.Join(fakeHome, "MyVault")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatalf("seed target: %v", err)
	}

	resp := mustPost(t, ts, "/api/v1/vault/create", map[string]any{
		"path":        target,
		"theme":       "dark",
		"mcp_enabled": false,
	})
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("creating vault next to app registry: want 200, got %d; body: %s", resp.StatusCode, b)
	}
}

// Regression: picking $HOME itself as the vault path used to trip the
// already_a_vault check because the app registry lives at $HOME/.jasper.
// Verify the create handler now treats that .jasper/ as the app registry,
// not a vault marker.
func TestPostVaultCreate_AtHomeContainingAppRegistry_Succeeds(t *testing.T) {
	fakeHome := t.TempDir()
	appHome := filepath.Join(fakeHome, ".jasper")
	if err := os.MkdirAll(appHome, 0o700); err != nil {
		t.Fatalf("seed app home: %v", err)
	}
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

	resp := mustPost(t, ts, "/api/v1/vault/create", map[string]any{
		"path":        fakeHome,
		"theme":       "dark",
		"mcp_enabled": false,
	})
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("creating vault at home containing app registry: want 200, got %d; body: %s", resp.StatusCode, b)
	}
}

// New footgun guard: refuse the app home itself as a vault target. Without
// this we'd happily create <appHome>/.jasper/ next to <appHome>/app.json,
// after which boot can't tell registry from vault.
func TestPostVaultCreate_AppHomeAsVault_Returns400(t *testing.T) {
	fakeHome := t.TempDir()
	appHome := filepath.Join(fakeHome, ".jasper")
	if err := os.MkdirAll(appHome, 0o700); err != nil {
		t.Fatalf("seed app home: %v", err)
	}
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

	resp := mustPost(t, ts, "/api/v1/vault/create", map[string]any{
		"path":        appHome,
		"theme":       "dark",
		"mcp_enabled": false,
	})
	if resp.StatusCode != http.StatusBadRequest {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("creating vault AT app home: want 400, got %d; body: %s", resp.StatusCode, b)
	}
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), "app home") {
		t.Errorf("error body should mention app home; got %s", b)
	}
}

// Inverse: opening $HOME (which contains the app registry $HOME/.jasper)
// must NOT be treated as opening a vault. Otherwise migrations run against
// the registry directory and corrupt app.json.
func TestPostVaultOpen_AtHomeContainingAppRegistry_Returns400(t *testing.T) {
	fakeHome := t.TempDir()
	appHome := filepath.Join(fakeHome, ".jasper")
	if err := os.MkdirAll(appHome, 0o700); err != nil {
		t.Fatalf("seed app home: %v", err)
	}
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

	resp := mustPost(t, ts, "/api/v1/vault/open", map[string]any{"path": fakeHome})
	if resp.StatusCode != http.StatusBadRequest {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("opening $HOME with only the app registry: want 400, got %d; body: %s", resp.StatusCode, b)
	}
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), "app registry") {
		t.Errorf("error body should mention app registry; got %s", b)
	}
}

func TestPostVaultCreate_NonASCII_Returns400(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)
	ts := setupVaultTestServer(t)
	defer ts.Close()

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

	jasperDir := filepath.Join(target, ".jasper")
	info, err := os.Stat(jasperDir)
	if err != nil {
		t.Fatalf(".jasper/ not created: %v", err)
	}
	if !info.IsDir() {
		t.Fatal(".jasper should be a directory")
	}

	cfgPath := filepath.Join(jasperDir, "config.json")
	if _, err := os.Stat(cfgPath); err != nil {
		t.Fatalf(".jasper/config.json not created: %v", err)
	}

	// app.db is intentionally NOT created by CreateVault — the migration
	// runner creates it on first server boot. CreateVault is mkdir +
	// config.Save + app.json register only.
	dbPath := filepath.Join(jasperDir, "app.db")
	if _, err := os.Stat(dbPath); err == nil {
		t.Fatalf("CreateVault should NOT create app.db (D-04); got file at %s", dbPath)
	}
}

func TestPostVaultForget_RemovesEntry(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

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

	resp := mustPost(t, ts, "/api/v1/vault/forget", map[string]any{"path": canB})
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 200, got %d; body: %s", resp.StatusCode, b)
	}

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

	resp := mustPost(t, ts, "/api/v1/vault/forget", map[string]any{"path": "/nonexistent/vault"})
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status: want 200, got %d; body: %s", resp.StatusCode, b)
	}
}

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
		t.Logf("body: %s", b)
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

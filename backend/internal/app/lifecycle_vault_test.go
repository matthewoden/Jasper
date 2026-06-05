package app

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

func writeAppJSON(t *testing.T, dir string, state *vault.AppState) string {
	t.Helper()
	path := filepath.Join(dir, "app.json")
	if err := vault.SaveAppJSON(path, state); err != nil {
		t.Fatalf("writeAppJSON: %v", err)
	}
	return path
}

func TestResolveVaultMode_EmptyAppJSON_NoVault(t *testing.T) {
	dir := t.TempDir()
	appJSONPath := writeAppJSON(t, dir, &vault.AppState{
		RecentVaults: []vault.RecentVaultEntry{},
	})

	mode, banner, openPath, err := resolveVaultMode(appJSONPath, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mode != modeNoVault {
		t.Errorf("mode: want modeNoVault, got %v", mode)
	}
	if banner != "" {
		t.Errorf("banner: want empty, got %q", banner)
	}
	if openPath != "" {
		t.Errorf("openPath: want empty, got %q", openPath)
	}
}

func TestResolveVaultMode_CurrentVaultExists_Open(t *testing.T) {
	dir := t.TempDir()

	vaultDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(vaultDir, ".jasper"), 0o700); err != nil {
		t.Fatal(err)
	}
	canonical, err := vault.Canonicalize(vaultDir)
	if err != nil {
		t.Fatal(err)
	}

	appJSONPath := writeAppJSON(t, dir, &vault.AppState{
		CurrentVault: canonical,
		RecentVaults: []vault.RecentVaultEntry{
			{Path: canonical, DisplayName: "Test", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
		},
	})

	mode, banner, openPath, err := resolveVaultMode(appJSONPath, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mode != modeOpen {
		t.Errorf("mode: want modeOpen, got %v", mode)
	}
	if banner != "" {
		t.Errorf("banner: want empty, got %q", banner)
	}
	if openPath != canonical {
		t.Errorf("openPath: want %q, got %q", canonical, openPath)
	}
}

func TestResolveVaultMode_V13_CurrentVaultMissing(t *testing.T) {
	dir := t.TempDir()

	missingPath := filepath.Join(t.TempDir(), "nonexistent-vault")
	appJSONPath := writeAppJSON(t, dir, &vault.AppState{
		CurrentVault: missingPath,
		RecentVaults: []vault.RecentVaultEntry{
			{Path: missingPath, DisplayName: "Gone Vault", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
		},
	})

	mode, banner, _, err := resolveVaultMode(appJSONPath, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mode != modeNoVault {
		t.Errorf("mode: want modeNoVault, got %v", mode)
	}
	if !strings.Contains(banner, "is no longer accessible") {
		t.Errorf("banner: want 'is no longer accessible', got %q", banner)
	}

	state, loadErr := vault.LoadAppJSON(appJSONPath)
	if loadErr != nil {
		t.Fatalf("reload app.json: %v", loadErr)
	}
	if state.CurrentVault != "" {
		t.Errorf("side effect: CurrentVault should be cleared, got %q", state.CurrentVault)
	}
	found := false
	for _, e := range state.RecentVaults {
		if e.Path == missingPath {
			found = true
			if !e.Missing {
				t.Errorf("side effect: entry should have Missing=true")
			}
		}
	}
	if !found {
		t.Errorf("side effect: entry for %q should still be in recent_vaults", missingPath)
	}
}

func TestResolveVaultMode_V14_DotJasperMissing(t *testing.T) {
	dir := t.TempDir()

	vaultDir := t.TempDir()
	canonical, err := vault.Canonicalize(vaultDir)
	if err != nil {
		t.Fatal(err)
	}

	appJSONPath := writeAppJSON(t, dir, &vault.AppState{
		CurrentVault: canonical,
		RecentVaults: []vault.RecentVaultEntry{
			{Path: canonical, DisplayName: "Broken Vault", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
		},
	})

	mode, banner, _, err := resolveVaultMode(appJSONPath, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mode != modeNoVault {
		t.Errorf("mode: want modeNoVault, got %v", mode)
	}
	if !strings.Contains(banner, "missing or corrupt") {
		t.Errorf("banner: want 'missing or corrupt', got %q", banner)
	}

	state, loadErr := vault.LoadAppJSON(appJSONPath)
	if loadErr != nil {
		t.Fatalf("reload app.json: %v", loadErr)
	}
	if state.CurrentVault != "" {
		t.Errorf("side effect: CurrentVault should be cleared, got %q", state.CurrentVault)
	}
	for _, e := range state.RecentVaults {
		if e.Path == canonical && !e.Missing {
			t.Errorf("side effect: entry should have Missing=true")
		}
	}
}

func TestResolveVaultMode_VaultOverride_BypassesAppJSON(t *testing.T) {
	dir := t.TempDir()

	vaultA := t.TempDir()
	vaultB := t.TempDir()
	for _, d := range []string{vaultA, vaultB} {
		if err := os.MkdirAll(filepath.Join(d, ".jasper"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	canA, _ := vault.Canonicalize(vaultA)
	canB, _ := vault.Canonicalize(vaultB)

	appJSONPath := writeAppJSON(t, dir, &vault.AppState{
		CurrentVault: canA,
		RecentVaults: []vault.RecentVaultEntry{
			{Path: canA, DisplayName: "A", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
		},
	})

	mode, _, openPath, err := resolveVaultMode(appJSONPath, canB)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mode != modeOpen {
		t.Errorf("mode: want modeOpen, got %v", mode)
	}
	if openPath != canB {
		t.Errorf("openPath: want %q (override), got %q", canB, openPath)
	}

	state, loadErr := vault.LoadAppJSON(appJSONPath)
	if loadErr != nil {
		t.Fatalf("reload app.json: %v", loadErr)
	}
	if state.CurrentVault != canA {
		t.Errorf("resolveVaultMode should not modify CurrentVault for the open path; got %q", state.CurrentVault)
	}
}

// TestApp_OpenVault_TouchesAppJSON verifies that OpenVault updates app.json:
// CurrentVault is set to the canonical vault path, and a RecentVaults entry
// is created (or updated) with the vault's path + a fresh LastOpenedAt.
func TestApp_OpenVault_TouchesAppJSON(t *testing.T) {
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

	appJSONPath := filepath.Join(appHome, "app.json")
	if err := vault.SaveAppJSON(appJSONPath, &vault.AppState{
		RecentVaults: []vault.RecentVaultEntry{},
	}); err != nil {
		t.Fatal(err)
	}
	before := time.Now()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(Config{
		DataDir:    canonical,
		ListenAddr: "127.0.0.1:0",
		Logger:     logger,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	openErr := make(chan error, 1)
	go func() { openErr <- a.OpenVault(ctx, canonical) }()

	deadline := time.Now().Add(5 * time.Second)
	var state *vault.AppState
	for time.Now().Before(deadline) {
		state, err = vault.LoadAppJSON(appJSONPath)
		if err != nil {
			t.Fatalf("reload app.json: %v", err)
		}
		if state.CurrentVault == canonical {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()

	select {
	case <-openErr:
	case <-time.After(10 * time.Second):
		t.Error("OpenVault goroutine did not return in time")
	}

	if state == nil {
		t.Fatal("state never populated")
	}
	if state.CurrentVault != canonical {
		t.Errorf("CurrentVault: want %q, got %q", canonical, state.CurrentVault)
	}
	var foundEntry bool
	for _, e := range state.RecentVaults {
		if e.Path == canonical {
			foundEntry = true
			if !e.LastOpenedAt.After(before) {
				t.Errorf("LastOpenedAt not advanced: %v (want > %v)", e.LastOpenedAt, before)
			}
			break
		}
	}
	if !foundEntry {
		t.Errorf("no RecentVaults entry for %q", canonical)
	}
}

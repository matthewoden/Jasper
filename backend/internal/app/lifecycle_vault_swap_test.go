package app

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

func setupSwapVault(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	canonical, err := vault.Canonicalize(dir)
	if err != nil {
		t.Fatalf("canonicalize vault dir: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(canonical, vault.SubdirName), 0o755); err != nil {
		t.Fatalf("mkdir .jasper: %v", err)
	}
	return canonical
}

func writeVaultMCPConfig(t *testing.T, vaultDir string, enabled bool, port int) {
	t.Helper()
	jasperDir := filepath.Join(vaultDir, vault.SubdirName)
	if err := os.MkdirAll(jasperDir, 0o755); err != nil {
		t.Fatalf("mkdir .jasper: %v", err)
	}
	cfg := config.DefaultConfig()
	cfg.MCP.Enabled = enabled
	cfg.MCP.Port = port
	cfg.MCP.Bind = "127.0.0.1"
	if err := config.Save(vaultDir, cfg); err != nil {
		t.Fatalf("write vault config: %v", err)
	}
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func newSwapApp(t *testing.T, dataDir string) *App {
	t.Helper()
	logger := discardLogger()
	a, err := New(Config{
		DataDir:    dataDir,
		ListenAddr: "127.0.0.1:0",
		Logger:     logger,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return a
}

// TestSwap_McpReleased — V-TEST-1.
// Vault A has a simulated MCP listener held on a free port. After SwitchVault
// to vault B (MCP disabled), that port is released.
func TestSwap_McpReleased(t *testing.T) {
	if testing.Short() {
		t.Skip("V-TEST-1: integration test; requires real net.Listen")
	}

	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	vaultA := setupSwapVault(t)
	vaultB := setupSwapVault(t)

	writeVaultMCPConfig(t, vaultB, false, 0)

	appJSONPath := filepath.Join(appHome, "app.json")
	appState := &vault.AppState{
		CurrentVault: vaultA,
		RecentVaults: []vault.RecentVaultEntry{
			{Path: vaultA, DisplayName: "VaultA", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
			{Path: vaultB, DisplayName: "VaultB", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
		},
	}
	if err := vault.SaveAppJSON(appJSONPath, appState); err != nil {
		t.Fatalf("save app.json: %v", err)
	}

	freeLn, freeAddr := pickFreeListener(t)
	_, portStr, _ := net.SplitHostPort(freeAddr)
	mcpPort, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("parse free port: %v", err)
	}
	_ = freeLn.Close()
	mcpLn, listenErr := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", mcpPort))
	if listenErr != nil {
		t.Fatalf("V-TEST-1: could not listen on free port %d: %v", mcpPort, listenErr)
	}

	held := true
	var holdMu sync.Mutex

	a := newSwapApp(t, vaultA)

	a.mcpShutdown = func(_ context.Context) error {
		holdMu.Lock()
		defer holdMu.Unlock()
		if held {
			held = false
			return mcpLn.Close()
		}
		return nil
	}

	ctx := context.Background()
	_, err = a.SwitchVault(ctx, vaultB)
	if err != nil {
		t.Fatalf("SwitchVault to vaultB: %v", err)
	}

	ln2, listenErr2 := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", mcpPort))
	if listenErr2 != nil {
		t.Fatalf("V-TEST-1 FAIL: port %d still held after switch to non-MCP vault: %v", mcpPort, listenErr2)
	}
	_ = ln2.Close()
}

// TestSwap_McpBoundOnSwitch — V-TEST-2.
// Vault A has no MCP. After SwitchVault to vault B (MCP enabled),
// the MCP listener is bound on a dynamic free port and responds to HTTP.
func TestSwap_McpBoundOnSwitch(t *testing.T) {
	if testing.Short() {
		t.Skip("V-TEST-2: integration test; requires real net.Listen")
	}

	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	freeLn, freeAddr := pickFreeListener(t)
	_, portStr, _ := net.SplitHostPort(freeAddr)
	mcpPort, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("parse free port: %v", err)
	}
	_ = freeLn.Close()

	vaultA := setupSwapVault(t)
	vaultB := setupSwapVault(t)
	writeVaultMCPConfig(t, vaultA, false, 0)

	appJSONPath := filepath.Join(appHome, "app.json")
	if err := vault.SaveAppJSON(appJSONPath, &vault.AppState{
		CurrentVault: vaultA,
		RecentVaults: []vault.RecentVaultEntry{
			{Path: vaultA, DisplayName: "VaultA", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
			{Path: vaultB, DisplayName: "VaultB", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
		},
	}); err != nil {
		t.Fatalf("save app.json: %v", err)
	}

	ctx := context.Background()
	if _, err := vault.CreateVault(ctx, vaultB, vault.CreateOpts{
		DisplayName: "VaultB",
		Theme:       "dark",
		MCPEnabled:  true,
	}); err != nil {
		t.Fatalf("pre-seed vaultB: %v", err)
	}

	// Write vault B config AFTER CreateVault so our dynamic port is not overwritten.
	writeVaultMCPConfig(t, vaultB, true, mcpPort)

	if err := vault.SaveAppJSON(appJSONPath, &vault.AppState{
		CurrentVault: vaultA,
		RecentVaults: []vault.RecentVaultEntry{
			{Path: vaultA, DisplayName: "VaultA", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
			{Path: vaultB, DisplayName: "VaultB", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
		},
	}); err != nil {
		t.Fatalf("restore app.json: %v", err)
	}

	a := newSwapApp(t, vaultA)

	entry, err := a.SwitchVault(ctx, vaultB)
	if err != nil {
		t.Fatalf("SwitchVault to vaultB: %v", err)
	}
	if entry.Path != vaultB {
		t.Errorf("returned entry path: want %q, got %q", vaultB, entry.Path)
	}

	var resp *http.Response
	mcpURL := fmt.Sprintf("http://127.0.0.1:%d/", mcpPort)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		resp, err = http.Get(mcpURL)
		if err == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("V-TEST-2 FAIL: MCP not bound after switch to MCP-enabled vault: %v", err)
	}
	_ = resp.Body.Close()

	if a.mcpShutdown != nil {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = a.mcpShutdown(shutdownCtx)
	}
}

// TestSwap_GrantsAreVaultScoped — V-TEST-3.
// After SwitchVault to vault B, a.pair is vault B's DB — grant DB scoping is
// guaranteed by construction (each vault has its own sqlite.Pair). Verify that
// a.pair changes to point to vault B's DB (different object pointer).
func TestSwap_GrantsAreVaultScoped(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	ctx := context.Background()

	vaultA := setupSwapVault(t)
	vaultB := setupSwapVault(t)
	writeVaultMCPConfig(t, vaultA, false, 0)
	writeVaultMCPConfig(t, vaultB, false, 0)

	if err := EnsureDataDir(vaultA); err != nil {
		t.Fatalf("EnsureDataDir A: %v", err)
	}

	appJSONPath := filepath.Join(appHome, "app.json")
	if err := vault.SaveAppJSON(appJSONPath, &vault.AppState{
		CurrentVault: vaultA,
		RecentVaults: []vault.RecentVaultEntry{
			{Path: vaultA, DisplayName: "VaultA", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
			{Path: vaultB, DisplayName: "VaultB", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
		},
	}); err != nil {
		t.Fatalf("save app.json: %v", err)
	}

	a := newSwapApp(t, vaultA)
	if err := a.initVaultSubsystemsOnly(ctx); err != nil {
		t.Fatalf("initVaultSubsystemsOnly(A): %v", err)
	}
	pairA := a.pair
	if pairA == nil {
		t.Fatal("a.pair should be non-nil after init")
	}

	_, err := a.SwitchVault(ctx, vaultB)
	if err != nil {
		t.Fatalf("SwitchVault to vaultB: %v", err)
	}

	if a.pair == nil {
		t.Fatal("V-TEST-3 FAIL: a.pair is nil after switch")
	}
	if a.pair == pairA {
		t.Fatal("V-TEST-3 FAIL: a.pair still points to vault A's DB after switch; grants are NOT vault-scoped")
	}
}

// TestSwap_DrainsMcpWriteInFlight — V-TEST-4.
// An in-flight write holds a.inFlightWrites.Add(1) for ~500ms before Done().
// SwitchVault must wait for the write to complete (>= 400ms elapsed) before
// tearing down.
func TestSwap_DrainsMcpWriteInFlight(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	ctx := context.Background()

	vaultA := setupSwapVault(t)
	vaultB := setupSwapVault(t)
	writeVaultMCPConfig(t, vaultA, false, 0)
	writeVaultMCPConfig(t, vaultB, false, 0)

	appJSONPath := filepath.Join(appHome, "app.json")
	if err := vault.SaveAppJSON(appJSONPath, &vault.AppState{
		CurrentVault: vaultA,
		RecentVaults: []vault.RecentVaultEntry{
			{Path: vaultA, DisplayName: "VaultA", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
			{Path: vaultB, DisplayName: "VaultB", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
		},
	}); err != nil {
		t.Fatalf("save app.json: %v", err)
	}

	a := newSwapApp(t, vaultA)
	if err := a.initVaultSubsystemsOnly(ctx); err != nil {
		t.Fatalf("initVaultSubsystemsOnly(A): %v", err)
	}

	addDone := make(chan struct{})
	writeDone := make(chan struct{})
	go func() {
		defer close(writeDone)
		a.inFlightWrites.Add(1)
		close(addDone)
		time.Sleep(500 * time.Millisecond)
		a.inFlightWrites.Done()
	}()

	<-addDone

	switchStart := time.Now()
	_, switchErr := a.SwitchVault(ctx, vaultB)
	switchDuration := time.Since(switchStart)

	if switchErr != nil {
		t.Fatalf("SwitchVault: %v", switchErr)
	}

	if switchDuration < 400*time.Millisecond {
		t.Errorf("V-TEST-4 FAIL: switch returned in %v; expected >= 400ms (drain did not wait for in-flight write)",
			switchDuration)
	}

	select {
	case <-writeDone:

	case <-time.After(2 * time.Second):
		t.Error("V-TEST-4: write goroutine did not complete within 2s")
	}
}

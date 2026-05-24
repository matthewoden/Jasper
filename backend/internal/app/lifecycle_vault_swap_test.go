package app

// lifecycle_vault_swap_test.go — Plan 08-17d Task 2 TDD tests for SwitchVault.
//
// V-TEST-1: Vault A (MCP enabled) → Vault B (MCP disabled).
//
//	After SwitchVault, port 6684 is released.
//
// V-TEST-2: Vault A (MCP disabled) → Vault B (MCP enabled).
//
//	After SwitchVault, MCP listener is bound on 6684 and responds.
//
// V-TEST-3: Vault A (MCP enabled) → Vault B (MCP enabled, different grants DB).
//
//	After SwitchVault, the active pair is the new vault's DB (grant scoping by construction).
//
// V-TEST-4: In-flight write during switch.
//
//	SwitchVault drains (waits >= 400ms) before tearing down; switch proceeds
//	normally after the write goroutine completes.
//
// Tests are in package app (white-box) so they can access unexported fields.

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/vault"
	"github.com/matthewoden/jasper/backend/migrations"
)

// setupSwapVault creates a minimal on-disk vault structure accepted by
// SwitchVault's validation (.jasper/ directory). Does NOT create the Jasper
// DB at storage/ — initVaultSubsystemsOnly creates that on demand.
// Returns the canonical vault path.
func setupSwapVault(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	canonical, err := vault.Canonicalize(dir)
	if err != nil {
		t.Fatalf("canonicalize vault dir: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(canonical, ".jasper"), 0o700); err != nil {
		t.Fatalf("mkdir .jasper: %v", err)
	}
	return canonical
}

// writeVaultMCPConfig writes <vaultDir>/storage/config.json with MCP
// enabled=<enabled> so initVaultSubsystemsOnly reads it during switch.
// Creates the storage/ subdir if missing.
func writeVaultMCPConfig(t *testing.T, vaultDir string, enabled bool) {
	t.Helper()
	storageDir := filepath.Join(vaultDir, "storage")
	if err := os.MkdirAll(storageDir, 0o755); err != nil {
		t.Fatalf("mkdir storage: %v", err)
	}
	cfg := config.DefaultConfig()
	cfg.MCP.Enabled = enabled
	cfg.MCP.Port = 6684
	cfg.MCP.Bind = "127.0.0.1"
	if err := config.Save(vaultDir, cfg); err != nil {
		t.Fatalf("write vault config: %v", err)
	}
}

// discardLogger returns a slog.Logger that discards all output.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// newSwapApp creates a minimal *App configured for SwitchVault tests.
// The App does NOT have a running HTTP listener — it is used for white-box
// SwitchVault verification only.
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
// Vault A has a simulated MCP listener held on port 6684. After SwitchVault
// to vault B (MCP disabled), port 6684 is released.
func TestSwap_McpReleased(t *testing.T) {
	if testing.Short() {
		t.Skip("V-TEST-1: integration test; requires real net.Listen on :6684")
	}

	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	// Create vault A and vault B directories.
	vaultA := setupSwapVault(t)
	vaultB := setupSwapVault(t)

	// Vault B: MCP disabled.
	writeVaultMCPConfig(t, vaultB, false)

	// Register both vaults in app.json.
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

	// Simulate a real MCP listener held by vault A on port 6684.
	mcpLn, err := net.Listen("tcp", "127.0.0.1:6684")
	if err != nil {
		t.Skipf("V-TEST-1: port 6684 already in use; skipping (%v)", err)
	}
	// The simulated "MCP server" just holds the port; release via the shutdown func.
	held := true
	var holdMu sync.Mutex

	// Build the App representing "vault A is already open with MCP on 6684".
	a := newSwapApp(t, vaultA)

	// Wire the simulated MCP shutdown into the App struct.
	a.mcpShutdown = func(_ context.Context) error {
		holdMu.Lock()
		defer holdMu.Unlock()
		if held {
			held = false
			return mcpLn.Close()
		}
		return nil
	}

	// SwitchVault to vault B (MCP disabled).
	ctx := context.Background()
	_, err = a.SwitchVault(ctx, vaultB)
	if err != nil {
		t.Fatalf("SwitchVault to vaultB: %v", err)
	}

	// After the switch, port 6684 must be released.
	ln2, listenErr := net.Listen("tcp", "127.0.0.1:6684")
	if listenErr != nil {
		t.Fatalf("V-TEST-1 FAIL: port 6684 still held after switch to non-MCP vault: %v", listenErr)
	}
	_ = ln2.Close()
}

// TestSwap_McpBoundOnSwitch — V-TEST-2.
// Vault A has no MCP. After SwitchVault to vault B (MCP enabled),
// the MCP listener is bound on 6684 and responds to HTTP.
func TestSwap_McpBoundOnSwitch(t *testing.T) {
	if testing.Short() {
		t.Skip("V-TEST-2: integration test; requires real net.Listen on :6684")
	}

	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	// Create vault A (no MCP) and vault B (MCP enabled).
	vaultA := setupSwapVault(t)
	vaultB := setupSwapVault(t)
	writeVaultMCPConfig(t, vaultA, false)
	writeVaultMCPConfig(t, vaultB, true)

	// Register in app.json.
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

	// Ensure vault B's storage/ has been seeded with migrations so
	// initVaultSubsystemsOnly can open its DB cleanly.
	ctx := context.Background()
	if _, err := vault.CreateVault(ctx, vaultB, vault.CreateOpts{
		DisplayName:  "VaultB",
		Theme:        "dark",
		MCPEnabled:   true,
		MigrationsFS: migrations.FS,
	}); err != nil {
		// CreateVault updates app.json again; re-save our test state after.
		t.Fatalf("pre-seed vaultB: %v", err)
	}
	// Re-save app.json so vault A is still the current vault.
	if err := vault.SaveAppJSON(appJSONPath, &vault.AppState{
		CurrentVault: vaultA,
		RecentVaults: []vault.RecentVaultEntry{
			{Path: vaultA, DisplayName: "VaultA", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
			{Path: vaultB, DisplayName: "VaultB", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
		},
	}); err != nil {
		t.Fatalf("restore app.json: %v", err)
	}

	// Check port 6684 is free before switch.
	ln0, err0 := net.Listen("tcp", "127.0.0.1:6684")
	if err0 != nil {
		t.Skipf("V-TEST-2: port 6684 already in use before test; skipping (%v)", err0)
	}
	_ = ln0.Close()

	// Build the App with vault A as DataDir (no MCP).
	a := newSwapApp(t, vaultA)
	// a.mcpShutdown is nil (no MCP on vault A).

	// Switch to vault B.
	entry, err := a.SwitchVault(ctx, vaultB)
	if err != nil {
		t.Fatalf("SwitchVault to vaultB: %v", err)
	}
	if entry.Path != vaultB {
		t.Errorf("returned entry path: want %q, got %q", vaultB, entry.Path)
	}

	// Verify MCP is now listening on 6684.
	// Give the listener a moment to settle (it starts in the background).
	var resp *http.Response
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		resp, err = http.Get("http://127.0.0.1:6684/")
		if err == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("V-TEST-2 FAIL: MCP not bound after switch to MCP-enabled vault: %v", err)
	}
	_ = resp.Body.Close()

	// Cleanup: shut down the MCP listener so it doesn't leak into other tests.
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

	// Create vault A and vault B, both fully initialized.
	vaultA := setupSwapVault(t)
	vaultB := setupSwapVault(t)
	writeVaultMCPConfig(t, vaultA, false)
	writeVaultMCPConfig(t, vaultB, false)

	// Pre-seed vault A's DB so initVaultSubsystemsOnly can open it.
	// (vault A is the initial vault; App.New doesn't run migrations.)
	if err := EnsureDataDir(vaultA); err != nil {
		t.Fatalf("EnsureDataDir A: %v", err)
	}

	// Register in app.json.
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

	// Build App with vault A; run initVaultSubsystemsOnly to open vault A's pair.
	a := newSwapApp(t, vaultA)
	if err := a.initVaultSubsystemsOnly(ctx); err != nil {
		t.Fatalf("initVaultSubsystemsOnly(A): %v", err)
	}
	pairA := a.pair
	if pairA == nil {
		t.Fatal("a.pair should be non-nil after init")
	}

	// Switch to vault B.
	_, err := a.SwitchVault(ctx, vaultB)
	if err != nil {
		t.Fatalf("SwitchVault to vaultB: %v", err)
	}

	// After switch, a.pair must be a different object (vault B's DB).
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

	// Create vault A (source) and vault B (target).
	vaultA := setupSwapVault(t)
	vaultB := setupSwapVault(t)
	writeVaultMCPConfig(t, vaultA, false)
	writeVaultMCPConfig(t, vaultB, false)

	// Register in app.json.
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

	// Build App with vault A and init so a.pair is set.
	a := newSwapApp(t, vaultA)
	if err := a.initVaultSubsystemsOnly(ctx); err != nil {
		t.Fatalf("initVaultSubsystemsOnly(A): %v", err)
	}

	// Simulate a slow in-flight write: hold inFlightWrites for 500ms.
	writeDone := make(chan struct{})
	go func() {
		defer close(writeDone)
		a.inFlightWrites.Add(1)
		time.Sleep(500 * time.Millisecond)
		a.inFlightWrites.Done()
	}()

	// Give the goroutine a moment to register in the WaitGroup.
	time.Sleep(20 * time.Millisecond)

	switchStart := time.Now()
	_, switchErr := a.SwitchVault(ctx, vaultB)
	switchDuration := time.Since(switchStart)

	if switchErr != nil {
		t.Fatalf("SwitchVault: %v", switchErr)
	}

	// V6 drain MUST have waited for the 500ms write to complete.
	// Allow 100ms tolerance for scheduler jitter.
	if switchDuration < 400*time.Millisecond {
		t.Errorf("V-TEST-4 FAIL: switch returned in %v; expected >= 400ms (drain did not wait for in-flight write)",
			switchDuration)
	}

	// Confirm the write goroutine completed cleanly.
	select {
	case <-writeDone:
		// OK
	case <-time.After(2 * time.Second):
		t.Error("V-TEST-4: write goroutine did not complete within 2s")
	}
}

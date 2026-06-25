package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kardianos/service"
	"github.com/spf13/cobra"

	_ "modernc.org/sqlite"

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

type fakeStatusProvider struct {
	state service.Status
	err   error
}

func (f *fakeStatusProvider) Status() (service.Status, error) { return f.state, f.err }

func withStatusFactory(t *testing.T, prov statusProvider) {
	t.Helper()
	orig := statusFactory
	statusFactory = func(string) (statusProvider, error) { return prov, nil }
	t.Cleanup(func() { statusFactory = orig })
}

func writeMinimalConfig(t *testing.T, dataDir string, cfg config.Config) {
	t.Helper()
	jasperDir := filepath.Join(dataDir, vault.SubdirName)
	if err := os.MkdirAll(jasperDir, 0o755); err != nil {
		t.Fatalf("mkdir .jasper: %v", err)
	}
	body, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal cfg: %v", err)
	}
	if err := os.WriteFile(vault.ConfigPath(dataDir), body, 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
}

// TestRunStatus_NoConfig_PrintsSetupHint asserts that with no config.json on
// disk, status prints the wizard hint.
func TestRunStatus_NoConfig_PrintsSetupHint(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JASPER_APP_HOME", filepath.Join(dir, "appHome"))
	orig := vaultFlag
	vaultFlag = dir
	t.Cleanup(func() { vaultFlag = orig })

	var buf bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&buf)

	if err := runStatus(cmd, nil); err != nil {
		t.Fatalf("runStatus: %v", err)
	}
	if !strings.Contains(buf.String(), "not yet set up") {
		t.Errorf("want setup hint, got %q", buf.String())
	}
}

// TestRunStatus_RunningService_PrintsAllFields drives the happy path —
// config on disk + running service → all six lines emitted with the
// expected substrings.
func TestRunStatus_RunningService_PrintsAllFields(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JASPER_APP_HOME", filepath.Join(dir, "appHome"))
	orig := vaultFlag
	vaultFlag = dir
	t.Cleanup(func() { vaultFlag = orig })
	writeMinimalConfig(t, dir, config.Config{
		AppName: "Jasper",
		Theme:   "dark",
		Server:  config.ServerConfig{Port: 6683, DataDir: dir},
		MCP:     config.MCPConfig{Enabled: false, Port: 6684, Bind: "127.0.0.1"},
	})
	withStatusFactory(t, &fakeStatusProvider{state: service.StatusRunning})

	var buf bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&buf)

	if err := runStatus(cmd, nil); err != nil {
		t.Fatalf("runStatus: %v", err)
	}
	out := buf.String()

	canon, err := vault.Canonicalize(dir)
	if err != nil {
		t.Fatalf("canonicalize: %v", err)
	}
	for _, want := range []string{
		"Jasper service: running",
		"Bound on:       127.0.0.1:6683",
		"Data directory: " + canon,
		vault.LogsPath(canon),
		"MCP enabled:    no",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("status output missing %q:\n%s", want, out)
		}
	}
}

// TestRunStatus_McpEnabledWithGrants pins the MCP summary line including
// per-grant breakdown.
func TestRunStatus_McpEnabledWithGrants(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JASPER_APP_HOME", filepath.Join(dir, "appHome"))
	orig := vaultFlag
	vaultFlag = dir
	t.Cleanup(func() { vaultFlag = orig })
	writeMinimalConfig(t, dir, config.Config{
		AppName: "Jasper",
		Theme:   "dark",
		Server:  config.ServerConfig{Port: 6683, DataDir: dir},
		MCP:     config.MCPConfig{Enabled: true, Port: 6684, Bind: "127.0.0.1"},
	})
	withStatusFactory(t, &fakeStatusProvider{state: service.StatusRunning})

	jasperDir := filepath.Join(dir, vault.SubdirName)
	if err := os.MkdirAll(jasperDir, 0o755); err != nil {
		t.Fatalf("mkdir .jasper: %v", err)
	}
	dbPath := vault.AppDBPath(dir)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `
		CREATE TABLE mcp_write_grants (
			id INTEGER PRIMARY KEY,
			folder_path TEXT NOT NULL UNIQUE,
			level INTEGER NOT NULL CHECK (level IN (1, 2)),
			granted_at INTEGER NOT NULL,
			granted_via TEXT NOT NULL DEFAULT 'tree-menu'
		);
		INSERT INTO mcp_write_grants (folder_path, level, granted_at) VALUES ('projects', 1, 1);
		INSERT INTO mcp_write_grants (folder_path, level, granted_at) VALUES ('scratch', 2, 1);
	`); err != nil {
		t.Fatalf("seed grants: %v", err)
	}
	_ = db.Close()

	var buf bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&buf)
	if err := runStatus(cmd, nil); err != nil {
		t.Fatalf("runStatus: %v", err)
	}
	out := buf.String()
	for _, want := range []string{
		"MCP enabled:    yes on 127.0.0.1:6684",
		"2 grants",
		"Tier 1 in projects/",
		"Tier 2 in scratch/",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("mcp output missing %q:\n%s", want, out)
		}
	}
}

// TestSummarizeGrants_MissingDB_GracefulNoGrants pins that a missing
// app.db doesn't crash the status path — summarizeGrants returns a
// friendly placeholder.
func TestSummarizeGrants_MissingDB_GracefulNoGrants(t *testing.T) {
	dir := t.TempDir()
	n, summary := summarizeGrants(dir)
	if n != 0 {
		t.Errorf("want n=0 for missing db, got %d", n)
	}
	if summary == "" {
		t.Errorf("want non-empty summary string")
	}
}

// TestHumanState pins the three branches of the kardianos status mapper.
func TestHumanState(t *testing.T) {
	cases := []struct {
		in   service.Status
		want string
	}{
		{service.StatusRunning, "running"},
		{service.StatusStopped, "stopped"},
		{service.StatusUnknown, "unknown (service may not be installed)"},
	}
	for _, tc := range cases {
		if got := humanState(tc.in); got != tc.want {
			t.Errorf("humanState(%v) = %q; want %q", tc.in, got, tc.want)
		}
	}
}

// TestStatusCmd_Registered pins rootCmd wiring.
func TestStatusCmd_Registered(t *testing.T) {
	found := false
	for _, c := range rootCmd.Commands() {
		if c.Use == "status" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("statusCmd not registered on rootCmd")
	}
}

func writeAppJSON(t *testing.T, appHome string, state *vault.AppState) string {
	t.Helper()
	if err := os.MkdirAll(appHome, 0o700); err != nil {
		t.Fatalf("mkdir app home: %v", err)
	}
	path := filepath.Join(appHome, "app.json")
	if err := vault.SaveAppJSON(path, state); err != nil {
		t.Fatalf("SaveAppJSON: %v", err)
	}
	return path
}

// TestStatus_PrintsVaultFromAppJSON verifies that when app.json has a current_vault
// and a matching recent_vaults entry, "status" prints the display_name and path.
func TestStatus_PrintsVaultFromAppJSON(t *testing.T) {
	dir := t.TempDir()
	appHome := filepath.Join(dir, "appHome")
	t.Setenv("JASPER_APP_HOME", appHome)

	orig := vaultFlag
	vaultFlag = ""
	t.Cleanup(func() { vaultFlag = orig })

	vaultDir := filepath.Join(dir, "myvault")
	if err := os.MkdirAll(vaultDir, 0o700); err != nil {
		t.Fatalf("mkdir vault: %v", err)
	}
	now := time.Now().UTC()
	state := &vault.AppState{
		CurrentVault: vaultDir,
		RecentVaults: []vault.RecentVaultEntry{
			{Path: vaultDir, DisplayName: "MyVault", LastOpenedAt: now, CreatedAt: now},
		},
	}
	writeAppJSON(t, appHome, state)

	var buf bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&buf)

	_ = runStatus(cmd, nil)
	out := buf.String()
	if !strings.Contains(out, "Vault:") {
		t.Errorf("want 'Vault:' line in status output:\n%s", out)
	}
	if !strings.Contains(out, "MyVault") {
		t.Errorf("want display_name 'MyVault' in output:\n%s", out)
	}
	if !strings.Contains(out, vaultDir) {
		t.Errorf("want vault path %q in output:\n%s", vaultDir, out)
	}
}

// TestStatusBoundOnLAN verifies that the "Bound on:" line derives the bind
// address from cfg.Server.Bind and appends the warning suffix for non-loopback.
func TestStatusBoundOnLAN(t *testing.T) {
	cases := []struct {
		bind        string
		wantAddr    string
		wantWarning bool
	}{
		{bind: "", wantAddr: "127.0.0.1:6683", wantWarning: false},
		{bind: "127.0.0.1", wantAddr: "127.0.0.1:6683", wantWarning: false},
		{bind: "0.0.0.0", wantAddr: "0.0.0.0:6683", wantWarning: true},
	}
	for _, tc := range cases {
		t.Run("bind="+tc.bind, func(t *testing.T) {
			cfg := config.Config{
				Server: config.ServerConfig{Port: 6683, Bind: tc.bind},
			}
			addr := serverBoundAddr(cfg)
			if addr != tc.wantAddr {
				t.Errorf("serverBoundAddr = %q; want %q", addr, tc.wantAddr)
			}

			dir := t.TempDir()
			t.Setenv("JASPER_APP_HOME", filepath.Join(dir, "appHome"))
			orig := vaultFlag
			vaultFlag = dir
			t.Cleanup(func() { vaultFlag = orig })
			writeMinimalConfig(t, dir, cfg)
			withStatusFactory(t, &fakeStatusProvider{state: service.StatusRunning})

			var buf bytes.Buffer
			cmd := &cobra.Command{}
			cmd.SetOut(&buf)
			if err := runStatus(cmd, nil); err != nil {
				t.Fatalf("runStatus: %v", err)
			}
			out := buf.String()

			if !strings.Contains(out, "Bound on:       "+tc.wantAddr) {
				t.Errorf("output missing 'Bound on:       %s':\n%s", tc.wantAddr, out)
			}
			if tc.wantWarning {
				if !strings.Contains(out, "[WARNING: exposed on all interfaces]") {
					t.Errorf("output missing warning suffix:\n%s", out)
				}
			} else {
				if strings.Contains(out, "[WARNING:") {
					t.Errorf("output should not contain warning suffix for loopback:\n%s", out)
				}
			}
		})
	}
}

// TestStatus_NoVaultSelectedShowsPickerMessage verifies that when app.json
// has no current_vault, the output says "none selected".
func TestStatus_NoVaultSelectedShowsPickerMessage(t *testing.T) {
	dir := t.TempDir()
	appHome := filepath.Join(dir, "appHome")
	t.Setenv("JASPER_APP_HOME", appHome)

	orig := vaultFlag
	vaultFlag = ""
	t.Cleanup(func() { vaultFlag = orig })

	state := &vault.AppState{RecentVaults: []vault.RecentVaultEntry{}}
	writeAppJSON(t, appHome, state)

	var buf bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&buf)

	_ = runStatus(cmd, nil)
	out := buf.String()
	if !strings.Contains(out, "none selected") {
		t.Errorf("want 'none selected' in output:\n%s", out)
	}
}

package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"

	_ "modernc.org/sqlite"

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

// TestDoctor_JSONFlag_EmitsParseableArray pins the --json contract:
// stdout is a single JSON array, each element shaped like DoctorCheck.
func TestDoctor_JSONFlag_EmitsParseableArray(t *testing.T) {
	dir := t.TempDir()
	// Plan 08-23 (R4-15): JASPER_DATA_DIR removed; use --vault (vaultFlag).
	orig := vaultFlag
	vaultFlag = dir
	t.Cleanup(func() { vaultFlag = orig })
	// Pre-seed the data dir with mode 0700 so checkDataDirPerms doesn't
	// fail noisily.
	_ = os.Chmod(dir, 0o700)
	t.Cleanup(func() { doctorJSON = false })
	doctorJSON = true

	var buf bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&buf)
	_ = runDoctor(cmd, nil)

	var arr []DoctorCheck
	if err := json.Unmarshal(buf.Bytes(), &arr); err != nil {
		t.Fatalf("--json output not parseable: %v\nbody=%s", err, buf.String())
	}
	if len(arr) != 11 {
		t.Errorf("want 11 checks (8 original + 3 vault checks), got %d", len(arr))
	}
	// Every entry must have a name and a status field.
	for i, c := range arr {
		if c.Name == "" {
			t.Errorf("check[%d] missing name", i)
		}
		if c.Status != "ok" && c.Status != "fail" && c.Status != "skip" {
			t.Errorf("check[%d] invalid status %q", i, c.Status)
		}
	}
}

// TestDoctor_TextOutput_HasMarkers pins the human-readable formatting:
// at least one ✓/✗/· marker per line.
func TestDoctor_TextOutput_HasMarkers(t *testing.T) {
	dir := t.TempDir()
	orig := vaultFlag
	vaultFlag = dir
	t.Cleanup(func() { vaultFlag = orig })
	_ = os.Chmod(dir, 0o700)
	t.Cleanup(func() { doctorJSON = false })
	doctorJSON = false

	var buf bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&buf)
	_ = runDoctor(cmd, nil)

	s := buf.String()
	hasAny := strings.Contains(s, "✓") || strings.Contains(s, "✗") || strings.Contains(s, "·")
	if !hasAny {
		t.Errorf("doctor text output has no markers:\n%s", s)
	}
}

// TestCheckPortAvailable_FreePort returns ok when the port is free.
func TestCheckPortAvailable_FreePort(t *testing.T) {
	// Bind ephemeral port, capture it, release, then probe.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()

	r := checkPortAvailable("server.port", port)
	if r.Status != "ok" {
		t.Errorf("free port: want ok, got %+v", r)
	}
}

// TestCheckPortAvailable_PortInUse returns fail when another listener
// is holding the port.
func TestCheckPortAvailable_PortInUse(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = ln.Close() }()
	port := ln.Addr().(*net.TCPAddr).Port

	r := checkPortAvailable("server.port", port)
	if r.Status != "fail" {
		t.Errorf("busy port: want fail, got %+v", r)
	}
	if !strings.Contains(r.Hint, "in use") {
		t.Errorf("hint missing 'in use': %q", r.Hint)
	}
}

// TestCheckPortAvailable_InvalidPort returns fail with the hint
// surfacing the invalid integer.
func TestCheckPortAvailable_InvalidPort(t *testing.T) {
	r := checkPortAvailable("server.port", 0)
	if r.Status != "fail" || !strings.Contains(r.Hint, "invalid port") {
		t.Errorf("port 0: want fail+invalid hint, got %+v", r)
	}
	r = checkPortAvailable("server.port", 99999)
	if r.Status != "fail" || !strings.Contains(r.Hint, "invalid port") {
		t.Errorf("port 99999: want fail+invalid hint, got %+v", r)
	}
}

// TestCheckDataDirPerms_0700_OK pins the happy path on a tempdir.
func TestCheckDataDirPerms_0700_OK(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows skips perm check")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	r := checkDataDirPerms(dir)
	if r.Status != "ok" {
		t.Errorf("0700 dir: want ok, got %+v", r)
	}
}

// TestCheckDataDirPerms_0777_Fail asserts the wider-than-0700 branch.
func TestCheckDataDirPerms_0777_Fail(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows skips perm check")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	r := checkDataDirPerms(dir)
	if r.Status != "fail" {
		t.Errorf("0777 dir: want fail, got %+v", r)
	}
	if !strings.Contains(r.Hint, "0700") {
		t.Errorf("hint should mention 0700: %q", r.Hint)
	}
}

// TestCheckDataDirPerms_Missing returns fail with the wizard hint.
func TestCheckDataDirPerms_Missing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "absent")
	r := checkDataDirPerms(dir)
	if r.Status != "fail" {
		t.Errorf("missing dir: want fail, got %+v", r)
	}
	if !strings.Contains(r.Hint, "wizard") {
		t.Errorf("hint should mention wizard: %q", r.Hint)
	}
}

// TestCheckLinger_NonLinuxSkips pins the skip-on-macOS branch.
func TestCheckLinger_NonLinuxSkips(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("test pins non-linux skip behavior")
	}
	r := checkLinger()
	if r.Status != "skip" {
		t.Errorf("non-linux: want skip, got %+v", r)
	}
}

// TestCheckWslSystemd_NonLinuxSkips pins the skip-on-macOS branch.
func TestCheckWslSystemd_NonLinuxSkips(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("test pins non-linux skip behavior")
	}
	r := checkWslSystemd()
	if r.Status != "skip" {
		t.Errorf("non-linux: want skip, got %+v", r)
	}
}

// TestCheckLogWritable_OKAndProbeCleanup pins the Blocker 3 contract:
// the probe writes to a SEPARATE file, jasper.log is never touched, and
// the probe is removed when the check returns.
func TestCheckLogWritable_OKAndProbeCleanup(t *testing.T) {
	dir := t.TempDir()
	r := checkLogWritable(dir)
	if r.Status != "ok" {
		t.Fatalf("want ok, got %+v", r)
	}
	// jasper.log MUST NOT have been created — the probe uses a separate
	// file. This is the Blocker 3 invariant (probe must not corrupt the
	// JSON slog stream by appending a stray byte).
	if _, err := os.Stat(filepath.Join(dir, "logs", "jasper.log")); err == nil {
		t.Errorf("jasper.log was created by probe — Blocker 3 regression!")
	}
	// .write-probe-* MUST have been removed.
	entries, err := os.ReadDir(filepath.Join(dir, "logs"))
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".write-probe-") {
			t.Errorf("leftover probe file %q (should have been removed)", e.Name())
		}
	}
}

// TestCheckLogWritable_UnwritableParent surfaces the mkdir-fail branch
// via a file-as-parent — MkdirAll under a regular file fails portably.
func TestCheckLogWritable_UnwritableParent(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}
	r := checkLogWritable(blocker)
	if r.Status != "fail" {
		t.Errorf("want fail for file-as-parent, got %+v", r)
	}
}

// TestCheckMigrationState_Ok seeds an in-place SQLite db whose
// schema_migrations row matches the highest embedded migration.
func TestCheckMigrationState_Ok(t *testing.T) {
	dir := t.TempDir()
	storageDir := filepath.Join(dir, "storage")
	if err := os.MkdirAll(storageDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	dbPath := filepath.Join(storageDir, "app.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	// Apply a schema_migrations table with a version higher than any
	// embedded migration. The embedded set tops out at 004; we use 999.
	if _, err := db.ExecContext(context.Background(), `
		CREATE TABLE schema_migrations (
			version INTEGER PRIMARY KEY,
			dirty INTEGER NOT NULL DEFAULT 0
		);
		INSERT INTO schema_migrations (version) VALUES (999);
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_ = db.Close()

	r := checkMigrationState(dir)
	if r.Status != "ok" {
		t.Errorf("want ok, got %+v", r)
	}
}

// TestCheckMigrationState_MissingSchemaMigrations fails when
// schema_migrations isn't on the DB.
func TestCheckMigrationState_MissingSchemaMigrations(t *testing.T) {
	dir := t.TempDir()
	storageDir := filepath.Join(dir, "storage")
	if err := os.MkdirAll(storageDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	dbPath := filepath.Join(storageDir, "app.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := db.ExecContext(context.Background(), `CREATE TABLE notes (id TEXT PRIMARY KEY);`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_ = db.Close()

	r := checkMigrationState(dir)
	if r.Status != "fail" {
		t.Errorf("want fail (no schema_migrations), got %+v", r)
	}
}

// TestCheckMigrationState_MissingDB fails with the wizard hint.
func TestCheckMigrationState_MissingDB(t *testing.T) {
	dir := t.TempDir()
	r := checkMigrationState(dir)
	if r.Status != "fail" {
		t.Errorf("want fail (missing db), got %+v", r)
	}
}

// TestMcpPortCheck_DisabledSkips short-circuits when MCP is off.
func TestMcpPortCheck_DisabledSkips(t *testing.T) {
	cfg := config.Config{MCP: config.MCPConfig{Enabled: false, Port: 6684}}
	r := mcpPortCheck(cfg)
	if r.Status != "skip" {
		t.Errorf("mcp disabled: want skip, got %+v", r)
	}
}

// TestDoctorCmd_Registered pins rootCmd wiring.
func TestDoctorCmd_Registered(t *testing.T) {
	found := false
	for _, c := range rootCmd.Commands() {
		if c.Use == "doctor" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("doctorCmd not registered on rootCmd")
	}
}

// TestRunDoctor_FailingChecks_ReturnsError ensures a failing check
// surfaces as a non-nil error so cobra exits with non-zero. We engineer
// a fail by pointing the data dir at a nonexistent path (data-dir perms
// + migration state + log writable will all fail).
func TestRunDoctor_FailingChecks_ReturnsError(t *testing.T) {
	// Use a path that resolves to a parent that's a regular file so even
	// log-writable's mkdir fails.
	dir := t.TempDir()
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}
	orig := vaultFlag
	vaultFlag = blocker
	t.Cleanup(func() { vaultFlag = orig })
	t.Cleanup(func() { doctorJSON = false })
	doctorJSON = false

	var buf bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&buf)
	err := runDoctor(cmd, nil)
	if err == nil {
		t.Errorf("want non-nil error when checks fail; got nil. output=%s", buf.String())
	}
}

// writeTestAppJSON writes an app.json to JASPER_APP_HOME for doctor tests.
func writeTestAppJSON(t *testing.T, appHome string, state *vault.AppState) {
	t.Helper()
	if err := os.MkdirAll(appHome, 0o700); err != nil {
		t.Fatalf("mkdir app home: %v", err)
	}
	if err := vault.SaveAppJSON(filepath.Join(appHome, "app.json"), state); err != nil {
		t.Fatalf("SaveAppJSON: %v", err)
	}
}

// TestDoctor_AppJSONReadableCheck_PassesOnValidFile verifies that a valid
// app.json produces a "app_json_readable" ok check.
func TestDoctor_AppJSONReadableCheck_PassesOnValidFile(t *testing.T) {
	dir := t.TempDir()
	appHome := filepath.Join(dir, "appHome")
	t.Setenv("JASPER_APP_HOME", appHome)
	orig := vaultFlag
	vaultFlag = dir
	t.Cleanup(func() { vaultFlag = orig })
	_ = os.Chmod(dir, 0o700)
	t.Cleanup(func() { doctorJSON = false })
	doctorJSON = false

	state := &vault.AppState{RecentVaults: []vault.RecentVaultEntry{}}
	writeTestAppJSON(t, appHome, state)

	var buf bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&buf)
	_ = runDoctor(cmd, nil)

	if !strings.Contains(buf.String(), "app_json_readable") {
		t.Errorf("want 'app_json_readable' check in output:\n%s", buf.String())
	}
	// The app_json_readable check should pass (✓).
	// Scan for the line containing app_json_readable and verify no ✗ marker.
	for _, line := range strings.Split(buf.String(), "\n") {
		if strings.Contains(line, "app_json_readable") {
			if strings.HasPrefix(line, "✗") {
				t.Errorf("app_json_readable should pass, got fail line: %q", line)
			}
			return
		}
	}
}

// TestDoctor_CurrentVaultMissingCheck_FailsAfterDeletion verifies that when
// current_vault is set but the folder is deleted, the check shows ✗.
func TestDoctor_CurrentVaultMissingCheck_FailsAfterDeletion(t *testing.T) {
	dir := t.TempDir()
	appHome := filepath.Join(dir, "appHome")
	t.Setenv("JASPER_APP_HOME", appHome)
	_ = os.Chmod(dir, 0o700)
	t.Cleanup(func() { doctorJSON = false })
	doctorJSON = false
	// Plan 08-23: --vault is the only override now; clear it so app.json
	// is the source of currentVault for this test.
	orig := vaultFlag
	vaultFlag = ""
	t.Cleanup(func() { vaultFlag = orig })

	// Create a vault dir, write app.json pointing at it, then delete the dir.
	vaultDir := filepath.Join(dir, "vault-to-delete")
	if err := os.Mkdir(vaultDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	now := time.Now().UTC()
	state := &vault.AppState{
		CurrentVault: vaultDir,
		RecentVaults: []vault.RecentVaultEntry{
			{Path: vaultDir, DisplayName: "gone", LastOpenedAt: now, CreatedAt: now},
		},
	}
	writeTestAppJSON(t, appHome, state)
	if err := os.Remove(vaultDir); err != nil {
		t.Fatalf("remove vault dir: %v", err)
	}

	var buf bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&buf)
	_ = runDoctor(cmd, nil)

	// Look for the ✗ current_vault_exists line.
	found := false
	for _, line := range strings.Split(buf.String(), "\n") {
		if strings.Contains(line, "current_vault_exists") && strings.HasPrefix(line, "✗") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("want '✗ current_vault_exists on disk' after deletion:\n%s", buf.String())
	}
}

// TestDoctor_JSONMode_IncludesNewChecks verifies that --json output includes
// the three new vault-related check keys.
func TestDoctor_JSONMode_IncludesNewChecks(t *testing.T) {
	dir := t.TempDir()
	appHome := filepath.Join(dir, "appHome")
	t.Setenv("JASPER_APP_HOME", appHome)
	_ = os.Chmod(dir, 0o700)
	t.Cleanup(func() { doctorJSON = false })
	doctorJSON = true
	// Plan 08-23: clear vaultFlag so app.json drives currentVault.
	orig := vaultFlag
	vaultFlag = ""
	t.Cleanup(func() { vaultFlag = orig })

	state := &vault.AppState{RecentVaults: []vault.RecentVaultEntry{}}
	writeTestAppJSON(t, appHome, state)

	var buf bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetOut(&buf)
	_ = runDoctor(cmd, nil)

	var arr []DoctorCheck
	if err := json.Unmarshal(buf.Bytes(), &arr); err != nil {
		t.Fatalf("--json output not parseable: %v\nbody=%s", err, buf.String())
	}

	wantKeys := []string{"app_json_readable", "current_vault_exists", "current_vault_has_jasper_dir"}
	for _, key := range wantKeys {
		found := false
		for _, c := range arr {
			if c.Name == key {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("key %q missing from JSON output; got names: %v", key, checkNames(arr))
		}
	}
}

// checkNames extracts the Name field from a slice of DoctorCheck.
func checkNames(arr []DoctorCheck) []string {
	names := make([]string, len(arr))
	for i, c := range arr {
		names[i] = c.Name
	}
	return names
}

package main

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/netbind"
)

// TestServeUsesNetbind is the cmd/jasper-side smoke confirmation that
// the loopback gate still lives at the expected import path after
// Phase 8 Plan 08-01 Task 3 moved the function out of package main.
// Coverage of the accept/reject matrix moved to
// backend/internal/netbind/netbind_test.go (7 cases). The single
// assertion here ensures the import is exercised so a refactor that
// silently drops the netbind dependency surfaces in this binary's
// test build.
func TestServeUsesNetbind(t *testing.T) {
	if err := netbind.RequireLoopbackBind("127.0.0.1:6683"); err != nil {
		t.Errorf("netbind.RequireLoopbackBind(127.0.0.1:6683): unexpected err: %v", err)
	}
}

// captureServeLog returns a *slog.Logger that writes to a bytes.Buffer,
// wires it as serveLog for the duration of the test, and returns the buffer.
func captureServeLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	l := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	setServeLogForTest(t, l)
	return &buf
}

// TestRunServe_VaultFlagOverridesEnv verifies that --vault takes precedence
// over JASPER_DATA_DIR. It sets both and asserts that no deprecation warning
// is logged for --vault (because --vault is the canonical path, not deprecated).
// We force an early exit by using a non-loopback address (RequireLoopbackBind
// fails AFTER the deprecation-warning switch, so the log check is still valid).
func TestRunServe_VaultFlagOverridesEnv(t *testing.T) {
	dir := t.TempDir()
	vaultDir := filepath.Join(dir, "myvault")
	if err := os.MkdirAll(vaultDir, 0o700); err != nil {
		t.Fatalf("mkdir vault: %v", err)
	}

	// Set JASPER_DATA_DIR to a different path so we can tell which one wins.
	t.Setenv("JASPER_DATA_DIR", filepath.Join(dir, "should-not-be-used"))

	// Set the vault flag directly (as cobra would set it from --vault <path>).
	orig := vaultFlag
	vaultFlag = vaultDir
	t.Cleanup(func() { vaultFlag = orig })

	buf := captureServeLog(t)

	// Use a non-loopback addr to make RequireLoopbackBind fail fast
	// (after the deprecation switch executes but before app.Run blocks).
	_ = runServe([]string{"--addr", "0.0.0.0:0"})

	if strings.Contains(buf.String(), "JASPER_DATA_DIR is deprecated") {
		t.Errorf("--vault flag should suppress JASPER_DATA_DIR deprecation warning, but saw it in log:\n%s", buf.String())
	}
}

// TestRunServe_DataDirFlagDeprecationLogged verifies that using --data-dir
// logs a deprecation warning. Uses a non-loopback addr for fast exit.
func TestRunServe_DataDirFlagDeprecationLogged(t *testing.T) {
	dir := t.TempDir()
	// Clear JASPER_DATA_DIR and vault flag so --data-dir resolution branch runs.
	t.Setenv("JASPER_DATA_DIR", "")
	orig := vaultFlag
	vaultFlag = ""
	t.Cleanup(func() { vaultFlag = orig })

	buf := captureServeLog(t)

	// Use a non-loopback addr to make RequireLoopbackBind fail fast
	// (after the deprecation switch executes but before app.Run blocks).
	_ = runServe([]string{"--data-dir", dir, "--addr", "0.0.0.0:0"})

	if !strings.Contains(buf.String(), "deprecated") {
		t.Errorf("--data-dir should log deprecation warning; log output:\n%s", buf.String())
	}
}

// TestRunServe_JasperDataDirEnvDeprecationLogged verifies that setting
// JASPER_DATA_DIR logs a deprecation warning. Uses a non-loopback addr for fast exit.
func TestRunServe_JasperDataDirEnvDeprecationLogged(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JASPER_DATA_DIR", dir)

	// Clear vault flag so the env branch runs.
	orig := vaultFlag
	vaultFlag = ""
	t.Cleanup(func() { vaultFlag = orig })

	buf := captureServeLog(t)

	// Use a non-loopback addr to make RequireLoopbackBind fail fast
	// (after the deprecation switch executes but before app.Run blocks).
	_ = runServe([]string{"--addr", "0.0.0.0:0"})

	if !strings.Contains(buf.String(), "JASPER_DATA_DIR is deprecated") {
		t.Errorf("JASPER_DATA_DIR should log deprecation warning; log output:\n%s", buf.String())
	}
}

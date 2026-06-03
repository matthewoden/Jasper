package main

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// captureServeLog returns a *slog.Logger that writes to a bytes.Buffer,
// wires it as serveLog for the duration of the test, and returns the buffer.
func captureServeLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	l := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	setServeLogForTest(t, l)
	return &buf
}

// TestRunServe_VaultFlagAccepted verifies that --vault is the canonical
// flag and runServe accepts it without error from fs.Parse. The bind gate
// is hit with a non-loopback addr so app.Run never starts.
func TestRunServe_VaultFlagAccepted(t *testing.T) {
	dir := t.TempDir()
	vaultDir := filepath.Join(dir, "myvault")
	if err := os.MkdirAll(vaultDir, 0o700); err != nil {
		t.Fatalf("mkdir vault: %v", err)
	}

	// Set the vault flag directly (as cobra would set it from --vault <path>).
	orig := vaultFlag
	vaultFlag = vaultDir
	t.Cleanup(func() { vaultFlag = orig })

	buf := captureServeLog(t)

	// Use a non-loopback addr to make RequireLoopbackBind fail fast
	// (after vault resolution executes but before app.Run blocks).
	_ = runServe([]string{"--addr", "0.0.0.0:0"})

	// Plan 08-23: --data-dir and JASPER_DATA_DIR were removed, so no
	// "deprecated" warning should ever appear.
	if strings.Contains(buf.String(), "deprecated") {
		t.Errorf("--vault flag should not produce any deprecation warnings, but saw it in log:\n%s", buf.String())
	}
}

// TestRunServe_DataDirFlagRejected — Plan 08-23 / R4-15: the --data-dir flag
// was removed entirely. fs.Parse must return an "unknown flag" error
// (Go stdlib default form: "flag provided but not defined: -data-dir").
func TestRunServe_DataDirFlagRejected(t *testing.T) {
	dir := t.TempDir()
	// Clear vault flag so --data-dir is the only override candidate.
	orig := vaultFlag
	vaultFlag = ""
	t.Cleanup(func() { vaultFlag = orig })

	// fs.Parse writes the unknown-flag error to the FlagSet's output;
	// captureServeLog isn't sufficient — but we DON'T need to read it.
	// runServe should return a non-nil error.
	_ = captureServeLog(t)

	err := runServe([]string{"--data-dir", dir, "--addr", "127.0.0.1:0"})
	if err == nil {
		t.Fatalf("expected error from runServe with removed --data-dir flag; got nil")
	}
	// stdlib flag.Parse error string is "flag provided but not defined: -data-dir"
	if !strings.Contains(err.Error(), "data-dir") {
		t.Errorf("expected error to mention data-dir; got: %v", err)
	}
}

// TestRunServe_JasperDataDirEnvIgnored — Plan 08-23 / R4-15: the JASPER_DATA_DIR
// env var is no longer recognized. Setting it must NOT produce any
// deprecation warning (the env var is silently ignored) and must NOT
// influence vault resolution.
func TestRunServe_JasperDataDirEnvIgnored(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JASPER_DATA_DIR", dir)

	// Clear vault flag.
	orig := vaultFlag
	vaultFlag = ""
	t.Cleanup(func() { vaultFlag = orig })

	buf := captureServeLog(t)

	// Use a non-loopback addr to make RequireLoopbackBind fail fast.
	_ = runServe([]string{"--addr", "0.0.0.0:0"})

	if strings.Contains(buf.String(), "JASPER_DATA_DIR") {
		t.Errorf("JASPER_DATA_DIR should be silently ignored (not recognized at all), but saw it in log:\n%s", buf.String())
	}
	if strings.Contains(buf.String(), "deprecated") {
		t.Errorf("no deprecation warning should be emitted post Plan 08-23; got:\n%s", buf.String())
	}
}

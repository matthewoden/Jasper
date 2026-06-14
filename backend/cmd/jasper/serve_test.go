package main

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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

	orig := vaultFlag
	vaultFlag = vaultDir
	t.Cleanup(func() { vaultFlag = orig })

	buf := captureServeLog(t)

	_ = runServe([]string{"--addr", "0.0.0.0:0"})

	if strings.Contains(buf.String(), "deprecated") {
		t.Errorf("--vault flag should not produce any deprecation warnings, but saw it in log:\n%s", buf.String())
	}
}

// TestRunServe_DataDirFlagRejected — the --data-dir flag was removed entirely.
// fs.Parse must return an "unknown flag" error.
func TestRunServe_DataDirFlagRejected(t *testing.T) {
	dir := t.TempDir()

	orig := vaultFlag
	vaultFlag = ""
	t.Cleanup(func() { vaultFlag = orig })

	_ = captureServeLog(t)

	err := runServe([]string{"--data-dir", dir, "--addr", "127.0.0.1:0"})
	if err == nil {
		t.Fatalf("expected error from runServe with removed --data-dir flag; got nil")
	}

	if !strings.Contains(err.Error(), "data-dir") {
		t.Errorf("expected error to mention data-dir; got: %v", err)
	}
}

// TestRunServe_JasperDataDirEnvIgnored — the JASPER_DATA_DIR env var is no
// longer recognized. Setting it must not produce any deprecation warning and
// must not influence vault resolution.
func TestRunServe_JasperDataDirEnvIgnored(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JASPER_DATA_DIR", dir)

	orig := vaultFlag
	vaultFlag = ""
	t.Cleanup(func() { vaultFlag = orig })

	buf := captureServeLog(t)

	_ = runServe([]string{"--addr", "0.0.0.0:0"})

	if strings.Contains(buf.String(), "JASPER_DATA_DIR") {
		t.Errorf("JASPER_DATA_DIR should be silently ignored (not recognized at all), but saw it in log:\n%s", buf.String())
	}
	if strings.Contains(buf.String(), "deprecated") {
		t.Errorf("no deprecation warning should be emitted post Plan 08-23; got:\n%s", buf.String())
	}
}

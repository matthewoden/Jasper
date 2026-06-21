package main

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/config"
)

func captureServeLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	l := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	setServeLogForTest(t, l)
	return &buf
}

// TestRunServe_VaultFlagAccepted verifies that --vault is the canonical
// flag and runServe accepts it without error from fs.Parse. A non-loopback
// --bind logs a warning; app.Run never starts because the vault dir is empty.
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

	_ = runServe([]string{"--bind", "0.0.0.0:0"})

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

	err := runServe([]string{"--data-dir", dir, "--bind", "127.0.0.1:0"})
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

	_ = runServe([]string{"--bind", "0.0.0.0:0"})

	if strings.Contains(buf.String(), "JASPER_DATA_DIR") {
		t.Errorf("JASPER_DATA_DIR should be silently ignored (not recognized at all), but saw it in log:\n%s", buf.String())
	}
	if strings.Contains(buf.String(), "deprecated") {
		t.Errorf("no deprecation warning should be emitted post Plan 08-23; got:\n%s", buf.String())
	}
}

// TestResolveBindAddr asserts the CLI-flag > config > default precedence
// for the HTTP listener bind address (NET-01).
func TestResolveBindAddr(t *testing.T) {
	makeConfig := func(bind string, port int) config.Config {
		cfg := config.Defaults()
		cfg.Server.Bind = bind
		cfg.Server.Port = port
		return cfg
	}

	tests := []struct {
		name           string
		cfg            config.Config
		bindFlagValue  string
		bindFlagSet    bool
		want           string
		wantErr        bool
	}{
		{
			name:    "default — no flag, no config bind",
			cfg:     makeConfig("", 6683),
			want:    defaultListenAddr, // 127.0.0.1:6683
		},
		{
			name:    "config server.bind takes effect when flag not set",
			cfg:     makeConfig("0.0.0.0", 6683),
			want:    "0.0.0.0:6683",
		},
		{
			name:    "config server.bind uses config port",
			cfg:     makeConfig("127.0.0.1", 6700),
			want:    "127.0.0.1:6700",
		},
		{
			name:           "CLI --bind overrides config server.bind",
			cfg:            makeConfig("0.0.0.0", 6683),
			bindFlagValue:  "127.0.0.1:6683",
			bindFlagSet:    true,
			want:           "127.0.0.1:6683",
		},
		{
			name:           "CLI --bind with non-loopback overrides loopback config",
			cfg:            makeConfig("127.0.0.1", 6683),
			bindFlagValue:  "0.0.0.0:6683",
			bindFlagSet:    true,
			want:           "0.0.0.0:6683",
		},
		{
			name:           "malformed --bind value returns error",
			cfg:            makeConfig("", 6683),
			bindFlagValue:  "not-an-addr",
			bindFlagSet:    true,
			wantErr:        true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveBindAddr(tt.cfg, tt.bindFlagValue, tt.bindFlagSet)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got addr %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

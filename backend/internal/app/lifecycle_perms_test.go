package app

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

// TestEnsureDataDir_Permissions pins the ADR-0030 decision (2026-08-01):
// .jasper/ and .trash/ are 0700, notes/ is 0755.
//
// Before this, all three were created 0755 while vault.CreateVault made
// .jasper/ 0700 and `jasper doctor` REQUIRED 0700 — so a lifecycle-created
// vault was world-readable and failed Jasper's own doctor check. Three sites
// disagreed; this test is what stops them drifting apart again.
func TestEnsureDataDir_Permissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode bits are not meaningful on Windows")
	}
	t.Parallel()

	dir := t.TempDir()
	if err := EnsureDataDir(dir); err != nil {
		t.Fatalf("EnsureDataDir: %v", err)
	}

	for _, tc := range []struct {
		sub  string
		want os.FileMode
		why  string
	}{
		{"notes", 0o755, "users legitimately point sync tools at notes/"},
		{vault.SubdirName, 0o700, "holds the index DB with full note bodies, plus MCP write grants"},
		{".trash", 0o700, "holds deleted note content"},
	} {
		fi, err := os.Stat(filepath.Join(dir, tc.sub))
		if err != nil {
			t.Errorf("stat %s: %v", tc.sub, err)
			continue
		}
		if got := fi.Mode().Perm(); got != tc.want {
			t.Errorf("%s: mode %#o, want %#o (%s)", tc.sub, got, tc.want, tc.why)
		}
	}
}

// TestEnsureDataDir_TightensExistingJasperDir: MkdirAll leaves an existing
// directory's mode alone, so vaults created by the previous 0755 code would
// stay world-readable and keep failing doctor forever. Startup repairs it.
func TestEnsureDataDir_TightensExistingJasperDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode bits are not meaningful on Windows")
	}
	t.Parallel()

	dir := t.TempDir()
	jasperDir := filepath.Join(dir, vault.SubdirName)
	if err := os.MkdirAll(jasperDir, 0o755); err != nil {
		t.Fatalf("pre-create .jasper at 0755: %v", err)
	}

	if err := EnsureDataDir(dir); err != nil {
		t.Fatalf("EnsureDataDir: %v", err)
	}

	fi, err := os.Stat(jasperDir)
	if err != nil {
		t.Fatalf("stat .jasper: %v", err)
	}
	if got := fi.Mode().Perm(); got != 0o700 {
		t.Errorf(".jasper mode %#o, want 0700 — an existing world-readable vault must be tightened, not left as-is", got)
	}
}

// TestBoot_IndexDBFilesAreOwnerOnly asserts the mode of the files that
// actually hold note content in derived form. The index DB carries full note
// bodies in body_fts, plus titles, tags, backlinks and mcp_write_grants —
// derived, but derived content is still content. The sqlite driver creates
// these 0644 by default.
func TestBoot_IndexDBFilesAreOwnerOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode bits are not meaningful on Windows")
	}
	t.Setenv("JASPER_APP_HOME", filepath.Join(t.TempDir(), ".jasper"))

	dir := t.TempDir()
	ln, addr := pickFreeListener(t)
	a, err := New(Config{
		DataDir:             dir,
		ListenAddr:          addr,
		ListenerOverride:    ln,
		Logger:              slog.New(slog.NewTextHandler(io.Discard, nil)),
		DisableFirstRunGate: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()
	if waitErr := waitFor(t, 5*time.Second, httpReadyProbe(addr)); waitErr != nil {
		cancel()
		<-runErr
		t.Fatalf("listener did not come up: %v", waitErr)
	}

	dbPath := vault.AppDBPath(dir)
	checked := 0
	for _, p := range []string{dbPath, dbPath + "-wal", dbPath + "-shm"} {
		fi, statErr := os.Stat(p)
		if statErr != nil {
			continue // -wal / -shm need not exist at every moment
		}
		checked++
		if got := fi.Mode().Perm(); got != 0o600 {
			t.Errorf("%s: mode %#o, want 0600", filepath.Base(p), got)
		}
	}
	if checked == 0 {
		t.Error("no index DB files found to check — the assertion proved nothing")
	}

	cancel()
	if err := <-runErr; err != nil {
		t.Errorf("Run returned error after cancel: %v", err)
	}
}

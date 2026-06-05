package migrate

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestPreflightFreeSpace_FreshDB_ReturnsNil — when dbPath does not exist
// (fresh data directory), PreflightFreeSpace returns nil because there is
// nothing to back up.
func TestPreflightFreeSpace_FreshDB_ReturnsNil(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	missing := filepath.Join(dir, "does-not-exist.db")
	if err := PreflightFreeSpace(missing); err != nil {
		t.Fatalf("PreflightFreeSpace(missing): got %v, want nil", err)
	}
}

// TestPreflightFreeSpace_LargeFreeSpace_OK — when the volume has plenty of
// free space relative to the (tiny) db file, PreflightFreeSpace returns
// nil. We avoid hard-coding a free-space minimum; any reasonable system
// has more than 2 bytes free.
func TestPreflightFreeSpace_LargeFreeSpace_OK(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "app.db")
	if err := os.WriteFile(dbPath, []byte("x"), 0o600); err != nil {
		t.Fatalf("seed db: %v", err)
	}
	if err := PreflightFreeSpace(dbPath); err != nil {
		t.Fatalf("PreflightFreeSpace(small file, large fs): got %v, want nil", err)
	}
}

// TestPreflightFreeSpace_ErrDiskFull_Wrapped — swap the package-level
// freeBytes variable with a mock that returns 0 bytes free, write a 100-
// byte file, assert PreflightFreeSpace wraps ErrDiskFull and surfaces
// the required/available numbers in the error message.
func TestPreflightFreeSpace_ErrDiskFull_Wrapped(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "app.db")
	if err := os.WriteFile(dbPath, make([]byte, 100), 0o600); err != nil {
		t.Fatalf("seed db: %v", err)
	}

	orig := freeBytes
	freeBytes = func(_ string) (uint64, error) { return 0, nil }
	t.Cleanup(func() { freeBytes = orig })

	err := PreflightFreeSpace(dbPath)
	if err == nil {
		t.Fatalf("PreflightFreeSpace: got nil, want ErrDiskFull")
	}
	if !errors.Is(err, ErrDiskFull) {
		t.Fatalf("PreflightFreeSpace: got %v, want errors.Is(err, ErrDiskFull) == true", err)
	}
	msg := err.Error()
	if !strings.Contains(msg, "need") {
		t.Errorf("error message lacks 'need': %q", msg)
	}
	if !strings.Contains(msg, "bytes free") {
		t.Errorf("error message lacks 'bytes free': %q", msg)
	}
}

// TestPreflightFreeSpace_StatError_Propagated — a non-NotExist Stat error
// (e.g. a parent directory with permissions stripped) propagates as a
// wrapped error. Skipped on Windows because the chmod permission model
// differs; v1 targets are macOS + WSL2 anyway (PROJECT.md).
func TestPreflightFreeSpace_StatError_Propagated(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission-bit test does not apply on Windows; v1 targets are macOS + WSL2")
	}
	if os.Geteuid() == 0 {
		t.Skip("root bypasses POSIX permission checks; skip when running as root")
	}
	t.Parallel()
	dir := t.TempDir()
	sub := filepath.Join(dir, "locked")
	if err := os.Mkdir(sub, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	dbPath := filepath.Join(sub, "app.db")
	if err := os.WriteFile(dbPath, []byte("x"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := os.Chmod(sub, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(sub, 0o700) })

	err := PreflightFreeSpace(dbPath)
	if err == nil {
		t.Fatalf("PreflightFreeSpace(no-perm): got nil, want wrapped permission error")
	}

	if errors.Is(err, ErrDiskFull) {
		t.Errorf("PreflightFreeSpace surfaced ErrDiskFull on a permission error: %v", err)
	}
	if !strings.Contains(err.Error(), "preflight stat") {
		t.Errorf("error not wrapped with 'preflight stat': %v", err)
	}
}

// TestFreeBytes_EnvHookForcesZero — the JASPER_TEST_FORCE_DISK_FULL=1
// env var short-circuits freeBytes to 0 (smoke-test hook for Plan
// 02-06). Setting other values (or not setting the var) preserves the
// real-syscall path.
func TestFreeBytes_EnvHookForcesZero(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JASPER_TEST_FORCE_DISK_FULL", "1")
	got, err := freeBytes(dir)
	if err != nil {
		t.Fatalf("freeBytes(env=1): %v", err)
	}
	if got != 0 {
		t.Fatalf("freeBytes(env=1): got %d, want 0", got)
	}

	t.Setenv("JASPER_TEST_FORCE_DISK_FULL", "0")
	got, err = freeBytes(dir)
	if err != nil {
		t.Fatalf("freeBytes(env=0): %v", err)
	}
	if got == 0 {
		t.Fatalf("freeBytes(env=0): got 0, want real syscall result (>0 on any non-full volume)")
	}
}

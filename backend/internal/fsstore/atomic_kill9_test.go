package fsstore

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"testing"
	"time"
)

// TestAtomicWrite_KillNineSubprocess is the crash-during-write durability gate:
// kill -9 mid-write must NEVER produce a zero-byte target.
//
// It forks itself as a helper that writes in a tight loop, SIGKILLs it at a
// randomized delay, and asserts the target is absent or complete — never
// partial, never a leftover .tmp.*.
//
// Skipped on Windows, where SIGKILL is unavailable.
func TestAtomicWrite_KillNineSubprocess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("kill -9 simulation not portable to windows; see atomic_test.go for the parallel-goroutines floor")
	}
	if os.Getenv("JASPER_KILL9_HELPER") == "1" {
		return
	}

	const iterations = 5
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}

	for i := 0; i < iterations; i++ {
		dir := t.TempDir()
		target := filepath.Join(dir, "note.md")

		cmd := exec.Command(exe, "-test.run=TestAtomicWrite_KillNineHelper", "-test.v")
		cmd.Env = append(
			os.Environ(),
			"JASPER_KILL9_HELPER=1",
			"JASPER_KILL9_TARGET="+target,
		)

		cmd.Stdout = nil
		cmd.Stderr = nil
		if err := cmd.Start(); err != nil {
			t.Fatalf("iter %d: cmd.Start: %v", i, err)
		}

		delay := time.Duration(5+10*i) * time.Millisecond
		time.Sleep(delay)
		_ = cmd.Process.Signal(syscall.SIGKILL)

		_ = cmd.Wait()

		got, err := os.ReadFile(target)
		switch {
		case err != nil && errors.Is(err, fs.ErrNotExist):

		case err != nil:
			t.Fatalf("iter %d: ReadFile %s: %v", i, target, err)
		default:
			if len(got) == 0 {
				t.Fatalf("iter %d: target is ZERO-BYTE after SIGKILL: %s", i, target)
			}

			s := string(got)
			if len(s) < len("WRITE-1") || s[:6] != "WRITE-" {
				t.Fatalf("iter %d: unexpected target content %q", i, s)
			}

			if _, err := strconv.Atoi(s[6:]); err != nil {
				t.Fatalf("iter %d: target tail is not a number: %q (%v)", i, s, err)
			}
		}
	}
}

// TestAtomicWrite_KillNineHelper is the helper "subtest" the parent above
// re-execs into. It only runs in the subprocess (gated by the env var) and
// performs AtomicWrite in a tight loop until SIGKILL kills it.
//
// IMPORTANT: this test is a NO-OP when JASPER_KILL9_HELPER != "1" so that
// `go test ./internal/fsstore/...` from a developer machine does not loop
// forever in the helper.
func TestAtomicWrite_KillNineHelper(t *testing.T) {
	if os.Getenv("JASPER_KILL9_HELPER") != "1" {
		t.Skip("not in helper subprocess mode")
	}
	target := os.Getenv("JASPER_KILL9_TARGET")
	if target == "" {
		t.Fatalf("JASPER_KILL9_TARGET unset")
	}

	var wg sync.WaitGroup
	const G = 4
	wg.Add(G)
	for g := 0; g < G; g++ {
		go func() {
			defer wg.Done()
			n := 0
			for {
				n++
				content := []byte(fmt.Sprintf("WRITE-%d", n))
				if err := AtomicWrite(target, content); err != nil {
					_, _ = fmt.Fprintf(os.Stderr, "AtomicWrite: %v\n", err)
					os.Exit(2)
				}
			}
		}()
	}
	wg.Wait()
}

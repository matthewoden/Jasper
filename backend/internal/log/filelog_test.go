package log

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestNewFileHandler_CreatesLogsDirAndFile asserts NewFileHandler mkdir-p's
// the logs dir it is handed and opens jasper.log inside it.
func TestNewFileHandler_CreatesLogsDirAndFile(t *testing.T) {
	t.Cleanup(func() { nowFunc = time.Now })

	logsDir := filepath.Join(t.TempDir(), ".jasper", "logs")
	h, closer, err := NewFileHandler(logsDir)
	if err != nil {
		t.Fatalf("NewFileHandler: %v", err)
	}
	defer func() { _ = closer.Close() }()

	slog.New(h).Info("hello", "k", "v")

	logsPath := filepath.Join(logsDir, "jasper.log")
	if _, err := os.Stat(logsPath); err != nil {
		t.Fatalf("expected jasper.log at %s: %v", logsPath, err)
	}
}

// TestNewFileHandler_LogsDirIsPrivate — the logs dir lives inside .jasper/
// and is Jasper's own data (ADR-0030), so it must be created 0700 rather
// than left world-readable on a shared host.
func TestNewFileHandler_LogsDirIsPrivate(t *testing.T) {
	t.Cleanup(func() { nowFunc = time.Now })

	logsDir := filepath.Join(t.TempDir(), ".jasper", "logs")
	_, closer, err := NewFileHandler(logsDir)
	if err != nil {
		t.Fatalf("NewFileHandler: %v", err)
	}
	defer func() { _ = closer.Close() }()

	info, err := os.Stat(logsDir)
	if err != nil {
		t.Fatalf("stat logs dir: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o700 {
		t.Errorf("logs dir mode: got %o, want 700", got)
	}
}

// TestNewFileHandler_WritesJSONRecords asserts each record is a single
// JSON line (the slog JSON handler contract). Two writes → two lines,
// both valid JSON.
func TestNewFileHandler_WritesJSONRecords(t *testing.T) {
	t.Cleanup(func() { nowFunc = time.Now })

	logsDir := filepath.Join(t.TempDir(), "logs")
	h, closer, err := NewFileHandler(logsDir)
	if err != nil {
		t.Fatalf("NewFileHandler: %v", err)
	}

	logger := slog.New(h)
	logger.Info("first", "a", 1)
	logger.Info("second", "b", 2)
	if err := closer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	body, err := os.ReadFile(filepath.Join(logsDir, "jasper.log"))
	if err != nil {
		t.Fatalf("read jasper.log: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(body), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("want 2 lines, got %d (body=%q)", len(lines), body)
	}
	for i, ln := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(ln), &m); err != nil {
			t.Errorf("line %d not JSON: %v (line=%q)", i, err, ln)
		}
		if _, ok := m["msg"]; !ok {
			t.Errorf("line %d missing msg field: %q", i, ln)
		}
	}
}

// TestNewFileHandler_AppendsToExistingLog — a restart (or a vault
// reopened later the same day) must extend jasper.log, not truncate the
// earlier session's records out of the diagnostic surface.
func TestNewFileHandler_AppendsToExistingLog(t *testing.T) {
	t.Cleanup(func() { nowFunc = time.Now })

	logsDir := filepath.Join(t.TempDir(), "logs")

	h1, c1, err := NewFileHandler(logsDir)
	if err != nil {
		t.Fatalf("NewFileHandler (first): %v", err)
	}
	slog.New(h1).Info("session-one")
	if err := c1.Close(); err != nil {
		t.Fatalf("close first: %v", err)
	}

	h2, c2, err := NewFileHandler(logsDir)
	if err != nil {
		t.Fatalf("NewFileHandler (second): %v", err)
	}
	slog.New(h2).Info("session-two")
	if err := c2.Close(); err != nil {
		t.Fatalf("close second: %v", err)
	}

	body, err := os.ReadFile(filepath.Join(logsDir, "jasper.log"))
	if err != nil {
		t.Fatalf("read jasper.log: %v", err)
	}
	for _, want := range []string{"session-one", "session-two"} {
		if !strings.Contains(string(body), want) {
			t.Errorf("jasper.log missing %q: %q", want, body)
		}
	}
}

// TestNewFileHandler_DailyRotation drives the rotation seam via nowFunc:
// day-1 write → simulate day-2 → next write rotates the file. We assert
// the rotated archive (jasper-<day1>.log) exists and the fresh
// jasper.log contains only the day-2 record.
func TestNewFileHandler_DailyRotation(t *testing.T) {
	t.Cleanup(func() { nowFunc = time.Now })

	logsDir := filepath.Join(t.TempDir(), "logs")

	day1 := time.Date(2026, 5, 17, 9, 0, 0, 0, time.UTC)
	day2 := time.Date(2026, 5, 18, 1, 0, 0, 0, time.UTC)

	nowFunc = func() time.Time { return day1 }
	h, closer, err := NewFileHandler(logsDir)
	if err != nil {
		t.Fatalf("NewFileHandler: %v", err)
	}

	logger := slog.New(h)
	logger.Info("day-one")

	nowFunc = func() time.Time { return day2 }
	logger.Info("day-two")
	if err := closer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	rotated := filepath.Join(logsDir, "jasper-2026-05-17.log")
	current := filepath.Join(logsDir, "jasper.log")

	rotBody, err := os.ReadFile(rotated)
	if err != nil {
		t.Fatalf("expected rotated archive at %s: %v", rotated, err)
	}
	if !strings.Contains(string(rotBody), "day-one") {
		t.Errorf("rotated archive missing day-one record: %q", rotBody)
	}
	if strings.Contains(string(rotBody), "day-two") {
		t.Errorf("rotated archive unexpectedly contains day-two: %q", rotBody)
	}

	curBody, err := os.ReadFile(current)
	if err != nil {
		t.Fatalf("read current jasper.log: %v", err)
	}
	if !strings.Contains(string(curBody), "day-two") {
		t.Errorf("current jasper.log missing day-two record: %q", curBody)
	}
	if strings.Contains(string(curBody), "day-one") {
		t.Errorf("current jasper.log unexpectedly contains day-one: %q", curBody)
	}
}

// TestFileSink_CloseIsIdempotent_AndPostCloseWriteErrors asserts that
// after Close, subsequent writes return os.ErrClosed and a second Close
// is a no-op.
func TestFileSink_CloseIsIdempotent_AndPostCloseWriteErrors(t *testing.T) {
	t.Cleanup(func() { nowFunc = time.Now })

	logsDir := filepath.Join(t.TempDir(), "logs")
	_, closer, err := NewFileHandler(logsDir)
	if err != nil {
		t.Fatalf("NewFileHandler: %v", err)
	}
	if err := closer.Close(); err != nil {
		t.Fatalf("first close: %v", err)
	}

	if err := closer.Close(); err != nil {
		t.Errorf("second close should be nil, got %v", err)
	}

	sink, ok := closer.(*fileSink)
	if !ok {
		t.Fatalf("closer not *fileSink: %T", closer)
	}
	if _, err := sink.Write([]byte("post-close\n")); err == nil {
		t.Errorf("post-close write: want error, got nil")
	}
}

// TestNewFileHandler_MkdirFails surfaces an mkdir failure when the logs
// dir resolves under a regular file. Using a file-as-parent guarantees
// MkdirAll fails on every supported OS.
func TestNewFileHandler_MkdirFails(t *testing.T) {
	t.Cleanup(func() { nowFunc = time.Now })

	dir := t.TempDir()

	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}
	if _, _, err := NewFileHandler(filepath.Join(blocker, "logs")); err == nil {
		t.Errorf("NewFileHandler under a file parent: want error, got nil")
	}
}

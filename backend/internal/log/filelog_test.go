package log

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestNewFileLogger_CreatesLogsDirAndFile asserts NewFileLogger mkdir-p's
// the logs dir under the chosen dataDir and opens jasper.log inside it.
func TestNewFileLogger_CreatesLogsDirAndFile(t *testing.T) {
	t.Cleanup(func() { nowFunc = time.Now })

	dir := t.TempDir()
	logger, closer, err := NewFileLogger(dir)
	if err != nil {
		t.Fatalf("NewFileLogger: %v", err)
	}
	defer func() { _ = closer.Close() }()

	logger.Info("hello", "k", "v")

	logsPath := filepath.Join(dir, "logs", "jasper.log")
	if _, err := os.Stat(logsPath); err != nil {
		t.Fatalf("expected jasper.log at %s: %v", logsPath, err)
	}
}

// TestNewFileLogger_WritesJSONRecords asserts each record is a single
// JSON line (the slog JSON handler contract). Two writes → two lines,
// both valid JSON.
func TestNewFileLogger_WritesJSONRecords(t *testing.T) {
	t.Cleanup(func() { nowFunc = time.Now })

	dir := t.TempDir()
	logger, closer, err := NewFileLogger(dir)
	if err != nil {
		t.Fatalf("NewFileLogger: %v", err)
	}

	logger.Info("first", "a", 1)
	logger.Info("second", "b", 2)
	if err := closer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	body, err := os.ReadFile(filepath.Join(dir, "logs", "jasper.log"))
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

// TestNewFileLogger_DailyRotation drives the rotation seam via nowFunc:
// day-1 write → simulate day-2 → next write rotates the file. We assert
// the rotated archive (jasper-<day1>.log) exists and the fresh
// jasper.log contains only the day-2 record.
func TestNewFileLogger_DailyRotation(t *testing.T) {
	t.Cleanup(func() { nowFunc = time.Now })

	dir := t.TempDir()

	day1 := time.Date(2026, 5, 17, 9, 0, 0, 0, time.UTC)
	day2 := time.Date(2026, 5, 18, 1, 0, 0, 0, time.UTC)

	nowFunc = func() time.Time { return day1 }
	logger, closer, err := NewFileLogger(dir)
	if err != nil {
		t.Fatalf("NewFileLogger: %v", err)
	}

	logger.Info("day-one")

	nowFunc = func() time.Time { return day2 }
	logger.Info("day-two")
	if err := closer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	rotated := filepath.Join(dir, "logs", "jasper-2026-05-17.log")
	current := filepath.Join(dir, "logs", "jasper.log")

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

	dir := t.TempDir()
	_, closer, err := NewFileLogger(dir)
	if err != nil {
		t.Fatalf("NewFileLogger: %v", err)
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

// TestNewFileLogger_MkdirFails surfaces an mkdir failure when dataDir
// resolves to an unwritable parent. Using a file-as-parent guarantees
// MkdirAll fails on every supported OS.
func TestNewFileLogger_MkdirFails(t *testing.T) {
	t.Cleanup(func() { nowFunc = time.Now })

	dir := t.TempDir()

	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}
	if _, _, err := NewFileLogger(blocker); err == nil {
		t.Errorf("NewFileLogger over a file parent: want error, got nil")
	}
}

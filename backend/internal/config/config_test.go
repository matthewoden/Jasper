package config

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

// newTestLogger returns a logger that discards all output — keeps test
// logs clean. Mirrors backend/internal/api/admin_status_test.go.
func newTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// mkdirStorage creates <dir>/storage with 0o755 perms — Save's caller
// contract per the package docstring. lifecycle.go does this in
// production via EnsureDataDir.
func mkdirStorage(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "storage"), 0o755); err != nil {
		t.Fatalf("mkdir storage: %v", err)
	}
}

// TestLoad_DefaultsOnMissing — D-39 first-run behavior. Load on a fresh
// dataDir returns DefaultConfig AND writes config.json to disk.
func TestLoad_DefaultsOnMissing(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := DefaultConfig()
	if cfg.Theme != want.Theme {
		t.Errorf("Theme: got %q, want %q", cfg.Theme, want.Theme)
	}
	if cfg.AppName != want.AppName {
		t.Errorf("AppName: got %q, want %q", cfg.AppName, want.AppName)
	}
	if cfg.Editor.FontSize != want.Editor.FontSize {
		t.Errorf("Editor.FontSize: got %d, want %d",
			cfg.Editor.FontSize, want.Editor.FontSize)
	}
	if cfg.DailyNotes.Folder != want.DailyNotes.Folder {
		t.Errorf("DailyNotes.Folder: got %q, want %q",
			cfg.DailyNotes.Folder, want.DailyNotes.Folder)
	}

	// Defaults must have been emitted to disk on first read.
	path := filepath.Join(dir, "storage", "config.json")
	if _, err := os.Stat(path); err != nil {
		t.Errorf("expected config.json on disk after first Load, got %v", err)
	}
}

// TestLoad_RoundTrip — D-39 GET round-trip semantics. Save then Load
// returns the same Config bit-for-bit (no field drift).
func TestLoad_RoundTrip(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)

	in := Config{
		AppName:    "Jasper",
		DailyNotes: DailyNotes{Folder: "journal", Template: "## {{date}}"},
		Editor:     Editor{FontSize: 16, LineHeight: 1.7, VimMode: true},
		Theme:      "light",
	}
	if err := Save(dir, in); err != nil {
		t.Fatalf("Save: %v", err)
	}

	out, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if out != in {
		t.Errorf("round-trip mismatch:\n got  %+v\n want %+v", out, in)
	}
}

// TestLoad_MalformedFallsBackToDefaults — D-39 / D-10 graceful fallback
// for parse errors. Load on a dir whose config.json is corrupt returns
// DefaultConfig WITHOUT overwriting the bad file (preserved for
// forensics).
func TestLoad_MalformedFallsBackToDefaults(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, "storage", "config.json")
	bad := []byte("not-json{{{")
	if err := os.WriteFile(path, bad, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v (want nil — malformed must NOT error)", err)
	}
	want := DefaultConfig()
	if cfg != want {
		t.Errorf("got %+v, want defaults %+v", cfg, want)
	}
	// Bad file MUST be preserved (no overwrite on malformed).
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after Load: %v", err)
	}
	if string(got) != string(bad) {
		t.Errorf("bad file was overwritten:\n got  %q\n want %q", got, bad)
	}
}

// TestLoad_UnknownFieldsFallBackToDefaults — D-40 strict decoding.
// A config.json with a field not declared on the struct triggers
// the malformed path; Load returns DefaultConfig (does NOT silently
// ignore the unknown key).
func TestLoad_UnknownFieldsFallBackToDefaults(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, "storage", "config.json")
	bad := []byte(`{"appName":"Jasper","theme":"dark","unknownKey":42,` +
		`"dailyNotes":{"folder":"daily","template":""},` +
		`"editor":{"fontSize":15,"lineHeight":1.6,"vimMode":false}}`)
	if err := os.WriteFile(path, bad, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := DefaultConfig()
	if cfg != want {
		t.Errorf("got %+v, want defaults (D-40 strict) %+v", cfg, want)
	}
}

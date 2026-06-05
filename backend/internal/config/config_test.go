package config

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

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
		Server:     ServerConfig{Port: 6683, DataDir: "/tmp/jasper-test"},
		MCP:        MCPConfig{Enabled: true, Port: 6684, Bind: "127.0.0.1"},
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

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after Load: %v", err)
	}
	if string(got) != string(bad) {
		t.Errorf("bad file was overwritten:\n got  %q\n want %q", got, bad)
	}
}

// TestDefaults_ServerAndMCP — Phase 8 D-50 / D-47. The Defaults factory
// must return canonical port + bind values for every downstream plan
// that reads cfg.Server.Port / cfg.MCP.* without re-deriving them.
func TestDefaults_ServerAndMCP(t *testing.T) {
	t.Parallel()
	d := Defaults()
	if d.Server.Port != 6683 {
		t.Errorf("Server.Port: got %d, want 6683 (D-50)", d.Server.Port)
	}
	if d.Server.DataDir == "" {
		t.Errorf("Server.DataDir: got empty; expected non-empty default (DefaultDataDir)")
	}
	if d.MCP.Port != 6684 {
		t.Errorf("MCP.Port: got %d, want 6684 (D-47)", d.MCP.Port)
	}
	if !d.MCP.Enabled {
		t.Errorf("MCP.Enabled: got false, want true (UAT-2 round 2 Q3 — default-on)")
	}
	if d.MCP.Bind != "127.0.0.1" {
		t.Errorf("MCP.Bind: got %q, want 127.0.0.1 (D-15)", d.MCP.Bind)
	}
	if d.Theme != "dark" {
		t.Errorf("Theme: got %q, want dark", d.Theme)
	}
	if d.AppName != "Jasper" {
		t.Errorf("AppName: got %q, want Jasper", d.AppName)
	}
}

// TestDefaults_MatchesDefaultConfig — DefaultConfig is the pre-Phase-8
// alias; both must return the same struct so existing callers keep
// working.
func TestDefaults_MatchesDefaultConfig(t *testing.T) {
	t.Parallel()
	if Defaults() != DefaultConfig() {
		t.Errorf("Defaults() != DefaultConfig(); alias must mirror the canonical factory")
	}
}

// TestDefaultDataDir_NonEmpty — the helper resolves to ~/.jasper on
// macOS/Linux. Asserts non-empty (the empty-string error path is
// triggered only when os.UserHomeDir fails, which is exceedingly rare
// in test environments).
func TestDefaultDataDir_NonEmpty(t *testing.T) {
	t.Parallel()
	got := DefaultDataDir()
	if got == "" {
		t.Skip("os.UserHomeDir returned empty/err — skipping (rare env)")
	}
	if !filepath.IsAbs(got) {
		t.Errorf("DefaultDataDir: got %q, want absolute path", got)
	}
}

// TestDefaults_JSONRoundTrip — the marshalled defaults must round-trip
// bit-for-bit and use the lowercase-first JSON keys required by
// api/openapi.yaml (server, port, dataDir, mcp, enabled, bind).
func TestDefaults_JSONRoundTrip(t *testing.T) {
	t.Parallel()
	d := Defaults()
	raw, err := json.Marshal(d)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{
		`"appName"`, `"theme"`, `"dailyNotes"`, `"editor"`,
		`"server"`, `"port"`, `"dataDir"`,
		`"mcp"`, `"enabled"`, `"bind"`,
	} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("missing JSON key %s in: %s", key, raw)
		}
	}
	var back Config
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back != d {
		t.Errorf("round-trip mismatch:\n got  %+v\n want %+v", back, d)
	}
}

// TestLoad_OldConfigWithoutServerOrMCP_BackCompat — Phase 8 backward
// compat. A pre-Phase-8 config.json (no `server`, no `mcp`) loads with
// the canonical defaults applied (Server.Port=6683, MCP.Port=6684,
// MCP.Bind=127.0.0.1) so downstream readers never see zero values.
func TestLoad_OldConfigWithoutServerOrMCP_BackCompat(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, "storage", "config.json")
	old := []byte(`{
		"appName":"Jasper","theme":"dark",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"vimMode":false}
	}`)
	if err := os.WriteFile(path, old, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Server.Port != 6683 {
		t.Errorf("Server.Port: got %d, want 6683 (defaulted)", cfg.Server.Port)
	}
	if cfg.MCP.Port != 6684 {
		t.Errorf("MCP.Port: got %d, want 6684 (defaulted)", cfg.MCP.Port)
	}
	if cfg.MCP.Bind != "127.0.0.1" {
		t.Errorf("MCP.Bind: got %q, want 127.0.0.1 (defaulted)", cfg.MCP.Bind)
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

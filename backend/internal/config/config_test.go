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

// .jasper literal allowed in this in-package test file: importing
// internal/vault here would create a test-only import cycle because
// vault.CreateVault depends on this config package.

func newTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// mkdirStorage creates <dir>/.jasper (the per-vault data subdir).
// Perms 0o755 match production EnsureDataDir.
func mkdirStorage(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".jasper"), 0o755); err != nil {
		t.Fatalf("mkdir .jasper: %v", err)
	}
}

// TestLoad_DefaultsOnMissing — Load on a fresh dataDir returns DefaultConfig
// AND writes config.json to disk.
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

	path := filepath.Join(dir, ".jasper", "config.json")
	if _, err := os.Stat(path); err != nil {
		t.Errorf("expected config.json on disk after first Load, got %v", err)
	}
}

// TestLoad_RoundTrip — Save then Load returns the same Config bit-for-bit
// (no field drift).
func TestLoad_RoundTrip(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)

	in := Config{
		AppName:     "Jasper",
		DailyNotes:  DailyNotes{Folder: "journal", Template: "## {{date}}"},
		Editor:      Editor{FontSize: 16, LineHeight: 1.7, VimMode: true, AutosaveMs: 3000},
		Theme:       "dark",
		Accent:      "sky",
		ReadingFont: "serif",
		Server:      ServerConfig{Port: 6683, DataDir: "/tmp/jasper-test", Bind: "127.0.0.1"},
		MCP:         MCPConfig{Port: 6684, Bind: "127.0.0.1"},
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

// TestLoad_MalformedFallsBackToDefaults — graceful fallback for parse
// errors. Load on a dir whose config.json is corrupt returns DefaultConfig
// WITHOUT overwriting the bad file (preserved for forensics).
func TestLoad_MalformedFallsBackToDefaults(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
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

// TestDefaults_ServerAndMCP — Defaults must return canonical port + bind
// values so downstream code reads cfg.Server.Port / cfg.MCP.* without
// re-deriving them.
func TestDefaults_ServerAndMCP(t *testing.T) {
	t.Parallel()
	d := Defaults()
	if d.Server.Port != 6683 {
		t.Errorf("Server.Port: got %d, want 6683", d.Server.Port)
	}
	if d.Server.DataDir == "" {
		t.Errorf("Server.DataDir: got empty; expected non-empty default (DefaultDataDir)")
	}
	if d.Server.Bind != "127.0.0.1" {
		t.Errorf("Server.Bind: got %q, want 127.0.0.1", d.Server.Bind)
	}
	if d.MCP.Port != 6684 {
		t.Errorf("MCP.Port: got %d, want 6684", d.MCP.Port)
	}
	if d.MCP.Bind != "127.0.0.1" {
		t.Errorf("MCP.Bind: got %q, want 127.0.0.1", d.MCP.Bind)
	}
	if d.Theme != "dark" {
		t.Errorf("Theme: got %q, want dark", d.Theme)
	}
	if d.AppName != "Jasper" {
		t.Errorf("AppName: got %q, want Jasper", d.AppName)
	}
}

// TestDefaults_MatchesDefaultConfig — DefaultConfig is an alias for
// Defaults(); both must return the same struct so existing callers keep
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
// api/openapi.yaml (server, port, dataDir, mcp, bind). No "enabled" key
// (Phase 24 D-06 removed the MCP listener toggle).
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
		`"mcp"`, `"bind"`,
		`"autosaveMs"`,
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

// TestLoad_OldConfigWithoutServerOrMCP_BackCompat — a config.json without
// `server` or `mcp` blocks loads with canonical defaults applied
// (Server.Port=6683, MCP.Port=6684, MCP.Bind=127.0.0.1) so downstream
// readers never see zero values.
func TestLoad_OldConfigWithoutServerOrMCP_BackCompat(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
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
	if cfg.Server.Bind != "127.0.0.1" {
		t.Errorf("Server.Bind: got %q, want 127.0.0.1 (defaulted)", cfg.Server.Bind)
	}
	if cfg.MCP.Port != 6684 {
		t.Errorf("MCP.Port: got %d, want 6684 (defaulted)", cfg.MCP.Port)
	}
	if cfg.MCP.Bind != "127.0.0.1" {
		t.Errorf("MCP.Bind: got %q, want 127.0.0.1 (defaulted)", cfg.MCP.Bind)
	}
}

// TestLoad_ThemeLightCoercedToDark — D-02: any persisted theme:"light"
// is coerced to "dark" on Load. The "light" value is still accepted on
// the wire (kept in OpenAPI enum) but the runtime is always dark.
func TestLoad_ThemeLightCoercedToDark(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	raw := []byte(`{
		"appName":"Jasper","theme":"light",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"vimMode":false,"autosaveMs":2000},
		"server":{"port":6683,"dataDir":"/tmp/j","bind":"127.0.0.1"},
		"mcp":{"port":6684,"bind":"127.0.0.1"}
	}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Theme != "dark" {
		t.Errorf("Theme: got %q, want %q (D-02 coercion)", cfg.Theme, "dark")
	}
}

// TestLoad_MissingAccentDefaultsToPurple — a config.json without the
// accent key loads with Accent defaulting to "purple".
func TestLoad_MissingAccentDefaultsToPurple(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	raw := []byte(`{
		"appName":"Jasper","theme":"dark",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"vimMode":false,"autosaveMs":2000},
		"server":{"port":6683,"dataDir":"/tmp/j","bind":"127.0.0.1"},
		"mcp":{"port":6684,"bind":"127.0.0.1"}
	}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Accent != "purple" {
		t.Errorf("Accent: got %q, want %q (defaulted when absent)", cfg.Accent, "purple")
	}
}

// TestLoad_MissingReadingFontDefaultsToSans — a config.json without the
// readingFont key loads with ReadingFont defaulting to "sans".
func TestLoad_MissingReadingFontDefaultsToSans(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	raw := []byte(`{
		"appName":"Jasper","theme":"dark",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"vimMode":false,"autosaveMs":2000},
		"server":{"port":6683,"dataDir":"/tmp/j","bind":"127.0.0.1"},
		"mcp":{"port":6684,"bind":"127.0.0.1"}
	}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ReadingFont != "sans" {
		t.Errorf("ReadingFont: got %q, want %q (defaulted when absent)", cfg.ReadingFont, "sans")
	}
}

// TestLoad_BogusAccentNormalizedToPurple — a config.json with an invalid
// accent value is normalized to "purple" on Load.
func TestLoad_BogusAccentNormalizedToPurple(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	raw := []byte(`{
		"appName":"Jasper","theme":"dark","accent":"bogus",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"vimMode":false,"autosaveMs":2000},
		"server":{"port":6683,"dataDir":"/tmp/j","bind":"127.0.0.1"},
		"mcp":{"port":6684,"bind":"127.0.0.1"}
	}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Accent != "purple" {
		t.Errorf("Accent: got %q, want %q (out-of-enum normalized)", cfg.Accent, "purple")
	}
}

// TestLoad_BogusReadingFontNormalizedToSans — a config.json with an
// invalid readingFont value is normalized to "sans" on Load.
func TestLoad_BogusReadingFontNormalizedToSans(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	raw := []byte(`{
		"appName":"Jasper","theme":"dark","readingFont":"bogus",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"vimMode":false,"autosaveMs":2000},
		"server":{"port":6683,"dataDir":"/tmp/j","bind":"127.0.0.1"},
		"mcp":{"port":6684,"bind":"127.0.0.1"}
	}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ReadingFont != "sans" {
		t.Errorf("ReadingFont: got %q, want %q (out-of-enum normalized)", cfg.ReadingFont, "sans")
	}
}

// TestLoad_ValidAccentAndReadingFontPreserved — a config.json with
// valid accent:"sky" and readingFont:"serif" round-trips without modification.
func TestLoad_ValidAccentAndReadingFontPreserved(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	raw := []byte(`{
		"appName":"Jasper","theme":"dark","accent":"sky","readingFont":"serif",
		"dailyNotes":{"folder":"daily","template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"vimMode":false,"autosaveMs":2000},
		"server":{"port":6683,"dataDir":"/tmp/j","bind":"127.0.0.1"},
		"mcp":{"port":6684,"bind":"127.0.0.1"}
	}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Accent != "sky" {
		t.Errorf("Accent: got %q, want %q", cfg.Accent, "sky")
	}
	if cfg.ReadingFont != "serif" {
		t.Errorf("ReadingFont: got %q, want %q", cfg.ReadingFont, "serif")
	}
}

// TestDefaults_AccentAndReadingFont — Defaults() returns Accent "purple"
// and ReadingFont "sans".
func TestDefaults_AccentAndReadingFont(t *testing.T) {
	t.Parallel()
	d := Defaults()
	if d.Accent != "purple" {
		t.Errorf("Accent: got %q, want %q", d.Accent, "purple")
	}
	if d.ReadingFont != "sans" {
		t.Errorf("ReadingFont: got %q, want %q", d.ReadingFont, "sans")
	}
}

// TestLoad_UnknownFieldsFallBackToDefaults — strict decoding: a
// config.json with an undeclared field triggers the malformed path;
// Load returns DefaultConfig (does NOT silently ignore the unknown key).
func TestLoad_UnknownFieldsFallBackToDefaults(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
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
		t.Errorf("got %+v, want defaults (strict decoding) %+v", cfg, want)
	}
}

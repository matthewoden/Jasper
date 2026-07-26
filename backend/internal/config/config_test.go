package config

import (
	"bytes"
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
		Editor:      Editor{FontSize: 16, LineHeight: 1.7, AutosaveMs: 3000, LineWidth: 900},
		Theme:       "dark",
		Accent:      "sky",
		ReadingFont: "serif",
		Server:      ServerConfig{Port: 6683, DataDir: "/tmp/jasper-test", Bind: "127.0.0.1"},
		MCP:         MCPConfig{Port: 6684, Bind: "127.0.0.1"},
		Templates:   Templates{Folder: "Templates"},
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
		"editor":{"fontSize":15,"lineHeight":1.6}
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
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":2000},
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
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":2000},
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
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":2000},
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
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":2000},
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
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":2000},
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
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":2000},
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

// TestLoad_UnknownFieldsAreDroppedNotFatal — D-13: an unrecognized key,
// top-level or nested, is silently dropped; every recognized field
// (including nested siblings of the unrecognized key) keeps its on-disk
// value. This replaces the prior strict-decoding contract, which asserted
// the exact opposite behavior D-13 inverts.
func TestLoad_UnknownFieldsAreDroppedNotFatal(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	raw := []byte(`{"appName":"Jasper","theme":"dark","someFutureField":42,` +
		`"dailyNotes":{"folder":"daily","template":""},` +
		`"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":3000,"someFutureNested":true}}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AppName != "Jasper" {
		t.Errorf("AppName: got %q, want %q (unrecognized top-level key must not fail the document)", cfg.AppName, "Jasper")
	}
	if cfg.Editor.AutosaveMs != 3000 {
		t.Errorf("Editor.AutosaveMs: got %d, want 3000 (recognized nested value must survive an unrecognized nested sibling key)", cfg.Editor.AutosaveMs)
	}
}

// TestLoad_LegacyMCPEnabledKeyIsDroppedNotFatal — closes the transitional
// regression 32-01's SUMMARY documented: MCPConfig.Enabled was deleted
// there, and until this plan's leniency landed, a legacy on-disk
// mcp.enabled key tripped the (then still-strict) malformed fallback. Now
// it is just an unrecognized key inside the mcp section: silently
// dropped, every other field (including its own mcp siblings and every
// other top-level section) survives.
func TestLoad_LegacyMCPEnabledKeyIsDroppedNotFatal(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	legacy := []byte(`{"appName":"Jasper","theme":"dark","accent":"sky",` +
		`"dailyNotes":{"folder":"journal","template":""},` +
		`"editor":{"fontSize":18,"lineHeight":1.7,"autosaveMs":3000},` +
		`"server":{"port":6683,"dataDir":"/tmp/jasper-legacy","bind":"127.0.0.1"},` +
		`"mcp":{"port":7000,"bind":"127.0.0.1","enabled":true}}`)
	if err := os.WriteFile(path, legacy, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Accent != "sky" {
		t.Errorf("Accent: got %q, want %q (legacy mcp.enabled must not wipe sibling sections)", cfg.Accent, "sky")
	}
	if cfg.DailyNotes.Folder != "journal" {
		t.Errorf("DailyNotes.Folder: got %q, want %q", cfg.DailyNotes.Folder, "journal")
	}
	if cfg.Editor.AutosaveMs != 3000 {
		t.Errorf("Editor.AutosaveMs: got %d, want 3000", cfg.Editor.AutosaveMs)
	}
	if cfg.MCP.Port != 7000 {
		t.Errorf("MCP.Port: got %d, want 7000 (legacy enabled key is dropped, not the whole mcp section)", cfg.MCP.Port)
	}
	if cfg.MCP.Bind != "127.0.0.1" {
		t.Errorf("MCP.Bind: got %q, want %q", cfg.MCP.Bind, "127.0.0.1")
	}
}

// TestLoad_WrongTypedFieldFallsBackPerField — the Pitfall-1 case: a
// wrong-typed known field (editor.fontSize as a string) reverts to only
// its own default, while a well-typed sibling field in the same nested
// section (editor.autosaveMs) survives, in one Load call. A single-shot
// Decode/Unmarshal against the whole editor struct cannot satisfy this.
func TestLoad_WrongTypedFieldFallsBackPerField(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	raw := []byte(`{"appName":"Jasper","theme":"dark",` +
		`"dailyNotes":{"folder":"daily","template":""},` +
		`"editor":{"fontSize":"big","lineHeight":1.6,"autosaveMs":3000}}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	wantFontSize := Defaults().Editor.FontSize
	if cfg.Editor.FontSize != wantFontSize {
		t.Errorf("Editor.FontSize: got %d, want default %d (wrong-typed field must revert to its own default)", cfg.Editor.FontSize, wantFontSize)
	}
	if cfg.Editor.AutosaveMs != 3000 {
		t.Errorf("Editor.AutosaveMs: got %d, want 3000 (sibling field must survive fontSize's type mismatch)", cfg.Editor.AutosaveMs)
	}
}

// TestLoad_OutOfRangeFallsBackNotClamped — D-14: a well-typed but
// out-of-range value reverts to the field's default, never clamped to the
// nearest bound.
func TestLoad_OutOfRangeFallsBackNotClamped(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	raw := []byte(`{"appName":"Jasper","theme":"dark",` +
		`"dailyNotes":{"folder":"daily","template":""},` +
		`"editor":{"fontSize":500,"lineHeight":1.6,"autosaveMs":2000,"lineWidth":9999}}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Editor.FontSize != 15 {
		t.Errorf("Editor.FontSize: got %d, want default 15 (must NOT be clamped to the 32 upper bound)", cfg.Editor.FontSize)
	}
	if cfg.Editor.LineWidth != 700 {
		t.Errorf("Editor.LineWidth: got %d, want default 700 (must NOT be clamped to the 2000 upper bound)", cfg.Editor.LineWidth)
	}
}

// TestLoad_BadFieldPreservesOtherSections — a bad field in one section
// (editor.lineHeight) must not disturb sibling sections' user-set values
// (dailyNotes, accent, server, templates).
func TestLoad_BadFieldPreservesOtherSections(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	raw := []byte(`{"appName":"Jasper","theme":"dark","accent":"sky",` +
		`"dailyNotes":{"folder":"journal","template":""},` +
		`"editor":{"fontSize":15,"lineHeight":"tall","autosaveMs":2000},` +
		`"server":{"port":6683,"dataDir":"/tmp/j","bind":"0.0.0.0"},` +
		`"templates":{"folder":"MyTemplates"}}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Editor.LineHeight != Defaults().Editor.LineHeight {
		t.Errorf("Editor.LineHeight: got %v, want default %v", cfg.Editor.LineHeight, Defaults().Editor.LineHeight)
	}
	if cfg.DailyNotes.Folder != "journal" {
		t.Errorf("DailyNotes.Folder: got %q, want %q (must survive editor's bad field)", cfg.DailyNotes.Folder, "journal")
	}
	if cfg.Accent != "sky" {
		t.Errorf("Accent: got %q, want %q (must survive editor's bad field)", cfg.Accent, "sky")
	}
	if cfg.Server.Bind != "0.0.0.0" {
		t.Errorf("Server.Bind: got %q, want %q (must survive editor's bad field)", cfg.Server.Bind, "0.0.0.0")
	}
	if cfg.Templates.Folder != "MyTemplates" {
		t.Errorf("Templates.Folder: got %q, want %q (must survive editor's bad field)", cfg.Templates.Folder, "MyTemplates")
	}
}

// TestLoad_InvalidEnumFallsBackToDefault — an invalid accent/readingFont
// enum member is treated like an out-of-range value: revert to default,
// while a non-default sibling field in the same document survives.
func TestLoad_InvalidEnumFallsBackToDefault(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	raw := []byte(`{"appName":"Jasper","theme":"dark","accent":"chartreuse","readingFont":"comic",` +
		`"dailyNotes":{"folder":"daily","template":""},` +
		`"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":3000}}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir, newTestLogger())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Accent != "purple" {
		t.Errorf("Accent: got %q, want %q (invalid enum falls back)", cfg.Accent, "purple")
	}
	if cfg.ReadingFont != "sans" {
		t.Errorf("ReadingFont: got %q, want %q (invalid enum falls back)", cfg.ReadingFont, "sans")
	}
	if cfg.Editor.AutosaveMs != 3000 {
		t.Errorf("Editor.AutosaveMs: got %d, want 3000 (survives sibling enum fallbacks)", cfg.Editor.AutosaveMs)
	}
}

// TestLoad_FallbackLogsWarn — D-15: a per-field fallback logs a warning
// naming the offending field path, and that log is the only surfacing
// mechanism (no other side channel is asserted or expected here).
func TestLoad_FallbackLogsWarn(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	raw := []byte(`{"appName":"Jasper","theme":"dark",` +
		`"dailyNotes":{"folder":"daily","template":""},` +
		`"editor":{"fontSize":"big","lineHeight":1.6,"autosaveMs":2000}}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))
	if _, err := Load(dir, log); err != nil {
		t.Fatalf("Load: %v", err)
	}

	out := buf.String()
	if !strings.Contains(out, "editor.fontSize") {
		t.Errorf("warn log missing offending field path %q; got:\n%s", "editor.fontSize", out)
	}
}

// TestLoad_NullScalarFieldWarnsAndFallsBack — CR-01: a literal JSON null on
// a single scalar field is a successful no-op for encoding/json (err == nil,
// target untouched), so it must be checked explicitly or D-15's "every
// fallback is logged" guarantee has a silent hole. Sibling fields in the
// same section must still decode normally.
func TestLoad_NullScalarFieldWarnsAndFallsBack(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	raw := []byte(`{"appName":"Jasper","theme":"dark",` +
		`"dailyNotes":{"folder":"daily","template":""},` +
		`"editor":{"fontSize":null,"lineHeight":1.6,"autosaveMs":3000}}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))
	cfg, err := Load(dir, log)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	wantFontSize := Defaults().Editor.FontSize
	if cfg.Editor.FontSize != wantFontSize {
		t.Errorf("Editor.FontSize: got %d, want default %d (null must fall back like any other fallback)", cfg.Editor.FontSize, wantFontSize)
	}
	if cfg.Editor.AutosaveMs != 3000 {
		t.Errorf("Editor.AutosaveMs: got %d, want 3000 (sibling field must survive fontSize's null)", cfg.Editor.AutosaveMs)
	}

	out := buf.String()
	if !strings.Contains(out, "editor.fontSize") || !strings.Contains(out, "null value") {
		t.Errorf("warn log missing null-value fallback for %q; got:\n%s", "editor.fontSize", out)
	}
}

// TestLoad_NullSectionWarnsAndFallsBack — CR-01: "server": null must revert
// the whole ServerConfig block (including DataDir) to defaults with a warn,
// not silently — a silent revert of dataDir is indistinguishable from data
// loss to the user. Sibling top-level sections must survive.
func TestLoad_NullSectionWarnsAndFallsBack(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	path := filepath.Join(dir, ".jasper", "config.json")
	raw := []byte(`{"appName":"Jasper","theme":"dark","accent":"sky",` +
		`"dailyNotes":{"folder":"journal","template":""},` +
		`"server":null}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))
	cfg, err := Load(dir, log)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	wantServer := Defaults().Server
	wantServer.Port = 6683 // Load's port-normalization pass always applies
	if cfg.Server.DataDir != wantServer.DataDir {
		t.Errorf("Server.DataDir: got %q, want default %q (null section must fall back, not silently keep a stale value)", cfg.Server.DataDir, wantServer.DataDir)
	}
	if cfg.Server.Bind != "127.0.0.1" {
		t.Errorf("Server.Bind: got %q, want %q (null section falls back)", cfg.Server.Bind, "127.0.0.1")
	}
	if cfg.DailyNotes.Folder != "journal" {
		t.Errorf("DailyNotes.Folder: got %q, want %q (must survive server's null section)", cfg.DailyNotes.Folder, "journal")
	}
	if cfg.Accent != "sky" {
		t.Errorf("Accent: got %q, want %q (must survive server's null section)", cfg.Accent, "sky")
	}

	out := buf.String()
	if !strings.Contains(out, "field=server") || !strings.Contains(out, "null value") {
		t.Errorf("warn log missing null-value fallback for %q; got:\n%s", "server", out)
	}
}

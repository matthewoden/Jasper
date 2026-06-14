package firstrun

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

// TestRunSetup_InvalidTheme exercises the up-front theme check:
// "darkmode" is not a valid choice and the error must surface before
// any filesystem work.
func TestRunSetup_InvalidTheme(t *testing.T) {
	t.Parallel()
	base := t.TempDir()
	target := filepath.Join(base, "Jasper")
	req := SetupRequest{
		DataDir: target,
		Theme:   "darkmode",
	}
	err := RunSetup(t.Context(), req)
	if err == nil {
		t.Fatalf("expected error for invalid theme; got nil")
	}
	if !strings.Contains(err.Error(), "theme must be") {
		t.Fatalf("unexpected error message: %v", err)
	}

	if _, err := os.Stat(vault.ConfigPath(target)); err == nil {
		t.Fatalf("config.json should not exist on theme-rejection path")
	}
}

// TestRunSetup_InvalidPath verifies that a non-ASCII data-dir is
// rejected at the ValidateDataDir gate (hostile client
// bypassing the debounced /validate-data-dir endpoint).
func TestRunSetup_InvalidPath(t *testing.T) {
	t.Parallel()

	req := SetupRequest{
		DataDir: "/tmp/Jasper-é",
		Theme:   "dark",
	}
	err := RunSetup(t.Context(), req)
	if err == nil {
		t.Fatalf("expected error for non-ASCII path; got nil")
	}
	if !strings.Contains(err.Error(), "don't survive cross-platform sync") {
		t.Fatalf("unexpected error message: %v", err)
	}
}

// TestRunSetup_HappyPath drives a fresh data-dir through the full
// submit pipeline and asserts every side effect lands correctly:
//   - <DataDir>/notes/   exists
//   - <DataDir>/.jasper/ exists (per-vault data subdir)
//   - <DataDir>/.jasper/config.json exists with the locked defaults
//     overlaid by the wizard's choices
//   - <DataDir>/.jasper/app.db exists with the mcp_write_grants table
//     populated by migration 004
//   - today's daily note exists when CreateTodayDailyNote=true
func TestRunSetup_HappyPath(t *testing.T) {
	t.Setenv("JASPER_APP_HOME", t.TempDir())
	base := t.TempDir()
	target := filepath.Join(base, "Jasper")
	req := SetupRequest{
		DataDir:              target,
		Theme:                "light",
		McpEnabled:           false,
		DailyTemplate:        "# {{date}}\n\n- ",
		CreateTodayDailyNote: true,
	}
	if err := RunSetup(t.Context(), req); err != nil {
		t.Fatalf("RunSetup: %v", err)
	}

	for _, sub := range []string{"notes", vault.SubdirName} {
		st, err := os.Stat(filepath.Join(target, sub))
		if err != nil {
			t.Fatalf("missing %s: %v", sub, err)
		}
		if !st.IsDir() {
			t.Fatalf("%s is not a directory", sub)
		}

		if st.Mode().Perm()&0o700 != 0o700 {
			t.Fatalf("%s perms 0o%o lack owner rwx", sub, st.Mode().Perm())
		}
	}

	cfg, err := config.Load(target, slog.Default())
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	// CreateVault canonicalizes DataDir (V10 contract: filepath.Abs →
	// EvalSymlinks → Clean → ToLower on darwin) so the stored value
	// differs from the raw target on case-insensitive filesystems.
	wantDataDir, _ := vault.Canonicalize(target)
	if cfg.Server.DataDir != wantDataDir {
		t.Fatalf("Server.DataDir: got %q want %q", cfg.Server.DataDir, wantDataDir)
	}
	if cfg.Theme != "light" {
		t.Fatalf("Theme: got %q want %q", cfg.Theme, "light")
	}
	if cfg.MCP.Enabled {
		t.Fatalf("MCP.Enabled: got true want false")
	}
	if cfg.Server.Port != 6683 {
		t.Fatalf("Server.Port: got %d want 6683 (Defaults must win when wizard does not override)", cfg.Server.Port)
	}
	if cfg.MCP.Port != 6684 {
		t.Fatalf("MCP.Port: got %d want 6684", cfg.MCP.Port)
	}
	if cfg.MCP.Bind != "127.0.0.1" {
		t.Fatalf("MCP.Bind: got %q want 127.0.0.1", cfg.MCP.Bind)
	}
	if cfg.DailyNotes.Template != "# {{date}}\n\n- " {
		t.Fatalf("DailyNotes.Template: got %q want template-override", cfg.DailyNotes.Template)
	}

	// app.db is intentionally NOT created by RunSetup: the migration
	// runner creates it on first server boot. With no wizard grants,
	// the seed_grants.json queue file is also absent (writeSeedGrants
	// short-circuits on empty input).
	if _, err := os.Stat(vault.AppDBPath(target)); err == nil {
		t.Fatalf("RunSetup should NOT create app.db (D-04); got file at %s", vault.AppDBPath(target))
	}
	canonical, err := vault.Canonicalize(target)
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	if _, err := os.Stat(vault.SeedGrantsPath(canonical)); err == nil {
		t.Fatalf("seed_grants.json should not exist when wizard submits no grants")
	}

	dailyDir := filepath.Join(target, "notes", "daily")
	entries, err := os.ReadDir(dailyDir)
	if err != nil {
		t.Fatalf("ReadDir daily/: %v", err)
	}
	var mdFound bool
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".md") {
			mdFound = true
		}
	}
	if !mdFound {
		t.Fatalf("today's daily note not created (entries=%v)", entries)
	}
}

// TestRunSetup_McpEnabledRoundTrips verifies that the wizard's
// mcp_enabled choice persists to cfg.MCP.Enabled on disk so the MCP
// listener sees the user's choice at next boot.
func TestRunSetup_McpEnabledRoundTrips(t *testing.T) {
	cases := []struct {
		name string
		req  SetupRequest
		want bool
	}{
		{
			name: "McpEnabled=true persists",
			req: SetupRequest{
				Theme:      "dark",
				McpEnabled: true,
			},
			want: true,
		},
		{
			name: "McpEnabled=false persists",
			req: SetupRequest{
				Theme:      "dark",
				McpEnabled: false,
			},
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("JASPER_APP_HOME", t.TempDir())
			base := t.TempDir()
			target := filepath.Join(base, "Jasper")
			tc.req.DataDir = target
			if err := RunSetup(t.Context(), tc.req); err != nil {
				t.Fatalf("RunSetup: %v", err)
			}
			cfg, err := config.Load(target, slog.Default())
			if err != nil {
				t.Fatalf("config.Load: %v", err)
			}
			if cfg.MCP.Enabled != tc.want {
				t.Fatalf("cfg.MCP.Enabled: got %v want %v", cfg.MCP.Enabled, tc.want)
			}
		})
	}
}

// TestRunSetup_SeedGrants — wizard MCP-grants seeding writes a queue
// file at <vault>/.jasper/seed_grants.json. Drain side of the contract
// is covered by apply_seed_grants_test.go.
func TestRunSetup_SeedGrants(t *testing.T) {
	t.Setenv("JASPER_APP_HOME", t.TempDir())
	base := t.TempDir()
	target := filepath.Join(base, "Jasper")
	req := SetupRequest{
		DataDir: target,
		Theme:   "dark",
		McpGrants: []SetupGrantSeed{
			{Folder: "inbox", Level: 1},
			{Folder: "projects/foo", Level: 2},
		},
	}
	if err := RunSetup(t.Context(), req); err != nil {
		t.Fatalf("RunSetup: %v", err)
	}

	canonical, err := vault.Canonicalize(target)
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	raw, err := os.ReadFile(vault.SeedGrantsPath(canonical))
	if err != nil {
		t.Fatalf("read seed_grants.json: %v", err)
	}
	var got []SetupGrantSeed
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal seed_grants.json: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("grants count: got %d want 2; queue=%+v", len(got), got)
	}
	if got[0] != (SetupGrantSeed{Folder: "inbox", Level: 1}) {
		t.Errorf("grant[0]: got %+v", got[0])
	}
	if got[1] != (SetupGrantSeed{Folder: "projects/foo", Level: 2}) {
		t.Errorf("grant[1]: got %+v", got[1])
	}
}

// TestRunSetup_SeedGrants_Duplicate — submit accepts a duplicated
// folder without error; the queue file preserves the wizard's raw
// list verbatim. The upsert/last-write-wins logic now lives in
// ApplySeedGrants (apply_seed_grants_test.go covers that side).
func TestRunSetup_SeedGrants_Duplicate(t *testing.T) {
	t.Setenv("JASPER_APP_HOME", t.TempDir())
	base := t.TempDir()
	target := filepath.Join(base, "Jasper")
	req := SetupRequest{
		DataDir: target,
		Theme:   "dark",
		McpGrants: []SetupGrantSeed{
			{Folder: "ai-zone", Level: 1},
			{Folder: "ai-zone", Level: 2},
		},
	}
	if err := RunSetup(t.Context(), req); err != nil {
		t.Fatalf("RunSetup with duplicate grant: %v", err)
	}

	canonical, err := vault.Canonicalize(target)
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	raw, err := os.ReadFile(vault.SeedGrantsPath(canonical))
	if err != nil {
		t.Fatalf("read seed_grants.json: %v", err)
	}
	var got []SetupGrantSeed
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal seed_grants.json: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("queue should preserve duplicate; got %d entries: %+v", len(got), got)
	}
	if got[0] != (SetupGrantSeed{Folder: "ai-zone", Level: 1}) ||
		got[1] != (SetupGrantSeed{Folder: "ai-zone", Level: 2}) {
		t.Errorf("queue order/content unexpected: %+v", got)
	}
}

// TestInsertSeedGrants_MixedDuplicates exercises a seed list with one
// duplicate (A appears twice) and one unique row (B appears once). The
// result must be exactly 2 rows: A at the last-seen level, B at its
// original level. Nil error is required.
func TestRunSetup_SeedGrants_MixedDuplicates(t *testing.T) {
	t.Setenv("JASPER_APP_HOME", t.TempDir())
	base := t.TempDir()
	target := filepath.Join(base, "Jasper")
	req := SetupRequest{
		DataDir: target,
		Theme:   "dark",
		McpGrants: []SetupGrantSeed{
			{Folder: "projects", Level: 1},
			{Folder: "inbox", Level: 1},
			{Folder: "projects", Level: 2},
		},
	}
	if err := RunSetup(t.Context(), req); err != nil {
		t.Fatalf("RunSetup with mixed duplicates: %v", err)
	}

	canonical, err := vault.Canonicalize(target)
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	raw, err := os.ReadFile(vault.SeedGrantsPath(canonical))
	if err != nil {
		t.Fatalf("read seed_grants.json: %v", err)
	}
	var got []SetupGrantSeed
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal seed_grants.json: %v", err)
	}
	// Queue preserves the wizard's submission order verbatim — the
	// dedup/upsert work lives in ApplySeedGrants.
	if len(got) != 3 {
		t.Fatalf("expected 3 raw entries in queue; got %d: %+v", len(got), got)
	}
	if got[0] != (SetupGrantSeed{Folder: "projects", Level: 1}) ||
		got[1] != (SetupGrantSeed{Folder: "inbox", Level: 1}) ||
		got[2] != (SetupGrantSeed{Folder: "projects", Level: 2}) {
		t.Errorf("queue order/content unexpected: %+v", got)
	}
}

// TestRunSetup_NoDailyNoteWhenOptedOut: omitting CreateTodayDailyNote
// MUST NOT touch the daily folder.
func TestRunSetup_NoDailyNoteWhenOptedOut(t *testing.T) {
	t.Setenv("JASPER_APP_HOME", t.TempDir())
	base := t.TempDir()
	target := filepath.Join(base, "Jasper")
	req := SetupRequest{
		DataDir:              target,
		Theme:                "dark",
		CreateTodayDailyNote: false,
	}
	if err := RunSetup(t.Context(), req); err != nil {
		t.Fatalf("RunSetup: %v", err)
	}
	if _, err := os.Stat(filepath.Join(target, "notes", "daily")); !os.IsNotExist(err) {
		entries, _ := os.ReadDir(filepath.Join(target, "notes", "daily"))
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".md") {
				t.Fatalf("daily/%s present but opt-in flag was false", e.Name())
			}
		}
	}
}

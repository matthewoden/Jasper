package firstrun

import (
	"database/sql"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/migrations"
)

// TestRunSetup_InvalidTheme exercises the up-front theme check —
// "darkmode" is not a valid choice and the error must surface BEFORE
// any filesystem work.
func TestRunSetup_InvalidTheme(t *testing.T) {
	t.Parallel()
	base := t.TempDir()
	target := filepath.Join(base, "Jasper")
	req := SetupRequest{
		DataDir: target,
		Theme:   "darkmode",
	}
	err := RunSetup(t.Context(), req, migrations.FS)
	if err == nil {
		t.Fatalf("expected error for invalid theme; got nil")
	}
	if !strings.Contains(err.Error(), "theme must be") {
		t.Fatalf("unexpected error message: %v", err)
	}

	if _, err := os.Stat(filepath.Join(target, "storage", "config.json")); err == nil {
		t.Fatalf("config.json should not exist on theme-rejection path")
	}
}

// TestRunSetup_InvalidPath verifies that a non-ASCII data-dir is
// rejected at the ValidateDataDir gate (T-08-06: hostile client
// bypassing the debounced /validate-data-dir endpoint).
func TestRunSetup_InvalidPath(t *testing.T) {
	t.Parallel()

	req := SetupRequest{
		DataDir: "/tmp/Jasper-é",
		Theme:   "dark",
	}
	err := RunSetup(t.Context(), req, migrations.FS)
	if err == nil {
		t.Fatalf("expected error for non-ASCII path; got nil")
	}
	if !strings.Contains(err.Error(), "don't survive cross-platform sync") {
		t.Fatalf("unexpected error message: %v", err)
	}
}

// TestRunSetup_HappyPath drives a fresh data-dir through the full
// submit pipeline and asserts every side effect lands correctly:
//   - <DataDir>/notes/   exists (0o700)
//   - <DataDir>/storage/ exists (0o700)
//   - <DataDir>/storage/config.json exists with the locked defaults
//     overlaid by the wizard's choices (legacy compat — plan 08-17b keeps this)
//   - <DataDir>/.jasper/app.db exists with the mcp_write_grants table
//     populated by migration 004 (vault model — plan 08-17b moved DB here)
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
	if err := RunSetup(t.Context(), req, migrations.FS); err != nil {
		t.Fatalf("RunSetup: %v", err)
	}

	for _, sub := range []string{"notes", "storage"} {
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
	if cfg.Server.DataDir != target {
		t.Fatalf("Server.DataDir: got %q want %q", cfg.Server.DataDir, target)
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

	dbPath := filepath.Join(target, ".jasper", "app.db")
	if _, err := os.Stat(dbPath); err != nil {
		t.Fatalf("missing app.db: %v", err)
	}
	db, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM mcp_write_grants`).Scan(&count); err != nil {
		t.Fatalf("query grants table: %v", err)
	}
	if count != 0 {
		t.Fatalf("mcp_write_grants count: got %d want 0", count)
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

// TestRunSetup_McpEnabledRoundTrips is the revision-2 W1 fix
// regression test: the wizard's mcp_enabled choice MUST persist to
// cfg.MCP.Enabled on disk so 08-09's listener sees the user's choice
// at next boot.
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
			if err := RunSetup(t.Context(), tc.req, migrations.FS); err != nil {
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

// TestRunSetup_SeedGrants exercises the wizard MCP-grants seeding —
// rows must land in mcp_write_grants with granted_via='wizard' and
// the user's chosen level (1 or 2).
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
	if err := RunSetup(t.Context(), req, migrations.FS); err != nil {
		t.Fatalf("RunSetup: %v", err)
	}

	dbPath := filepath.Join(target, ".jasper", "app.db")
	db, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	rows, err := db.Query(`SELECT folder_path, level, granted_via FROM mcp_write_grants ORDER BY folder_path`)
	if err != nil {
		t.Fatalf("query grants: %v", err)
	}
	defer func() { _ = rows.Close() }()
	type row struct {
		folder string
		level  int
		via    string
	}
	var got []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.folder, &r.level, &r.via); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got = append(got, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("grants count: got %d want 2; rows=%+v", len(got), got)
	}
	if got[0] != (row{folder: "inbox", level: 1, via: "wizard"}) {
		t.Errorf("row[0]: got %+v", got[0])
	}
	if got[1] != (row{folder: "projects/foo", level: 2, via: "wizard"}) {
		t.Errorf("row[1]: got %+v", got[1])
	}
}

// TestInsertSeedGrants_Duplicate_LastWriteWinsOnLevel exercises the
// ON CONFLICT(folder_path) DO UPDATE upsert semantics of insertSeedGrants
// (UAT-1 N8 layer 3). Two rows with the same Folder ("ai-zone") but
// Level=1 then Level=2 must: (a) return nil error, (b) leave exactly
// one row in mcp_write_grants, (c) with level=2 (last-write-wins).
//
// Before the ON CONFLICT fix, the second INSERT hit SQLite extended error
// 2067 (SQLITE_CONSTRAINT_UNIQUE) and returned a non-nil error — the
// whole wizard submit failed with:
//
//	"seed grants: insert grant "ai-zone": constraint failed: UNIQUE
//	 constraint failed: mcp_write_grants.folder_path (2067)"
func TestInsertSeedGrants_Duplicate_LastWriteWinsOnLevel(t *testing.T) {
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
	if err := RunSetup(t.Context(), req, migrations.FS); err != nil {
		t.Fatalf("RunSetup with duplicate grant: %v", err)
	}

	dbPath := filepath.Join(target, ".jasper", "app.db")
	db, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	var count int
	if err := db.QueryRow(`SELECT count(*) FROM mcp_write_grants`).Scan(&count); err != nil {
		t.Fatalf("query count: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected exactly 1 row after duplicate upsert; got %d", count)
	}

	var level int
	if err := db.QueryRow(`SELECT level FROM mcp_write_grants WHERE folder_path = 'ai-zone'`).Scan(&level); err != nil {
		t.Fatalf("query level: %v", err)
	}
	if level != 2 {
		t.Fatalf("expected level=2 (last-write-wins); got %d", level)
	}
}

// TestInsertSeedGrants_MixedDuplicates exercises a seed list with one
// duplicate (A appears twice) and one unique row (B appears once). The
// result must be exactly 2 rows: A at the last-seen level, B at its
// original level. Nil error is required.
func TestInsertSeedGrants_MixedDuplicates(t *testing.T) {
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
	if err := RunSetup(t.Context(), req, migrations.FS); err != nil {
		t.Fatalf("RunSetup with mixed duplicates: %v", err)
	}

	dbPath := filepath.Join(target, ".jasper", "app.db")
	db, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	var count int
	if err := db.QueryRow(`SELECT count(*) FROM mcp_write_grants`).Scan(&count); err != nil {
		t.Fatalf("query count: %v", err)
	}
	if count != 2 {
		t.Fatalf("expected exactly 2 rows after mixed-duplicate upsert; got %d", count)
	}

	rows, err := db.Query(`SELECT folder_path, level FROM mcp_write_grants ORDER BY folder_path`)
	if err != nil {
		t.Fatalf("query rows: %v", err)
	}
	defer func() { _ = rows.Close() }()
	type row struct {
		folder string
		level  int
	}
	var got []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.folder, &r.level); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got = append(got, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows err: %v", err)
	}

	if got[0] != (row{folder: "inbox", level: 1}) {
		t.Errorf("row[0]: got %+v want {inbox, 1}", got[0])
	}
	if got[1] != (row{folder: "projects", level: 2}) {
		t.Errorf("row[1]: got %+v want {projects, 2}", got[1])
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
	if err := RunSetup(t.Context(), req, migrations.FS); err != nil {
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

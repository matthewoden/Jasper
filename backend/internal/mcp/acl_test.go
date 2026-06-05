package mcp_test

import (
	"context"
	"database/sql"
	"io/fs"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/matthewoden/jasper/backend/internal/mcp"
	"github.com/matthewoden/jasper/backend/migrations"
)

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	dsn := "file:" + dbPath + "?_pragma=foreign_keys(ON)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatalf("ReadDir migrations.FS: %v", err)
	}
	ctx := context.Background()
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if len(name) < 4 || name[len(name)-4:] != ".sql" {
			continue
		}
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if _, err := db.ExecContext(ctx, string(body)); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
	}
	return db
}

func newACL(t *testing.T) *mcp.ACL {
	t.Helper()
	return mcp.NewACL(openTestDB(t))
}

func TestACL_Set_ListRoundTrip(t *testing.T) {
	a := newACL(t)
	ctx := context.Background()

	g, err := a.Set(ctx, "projects", mcp.TierEditOnly, "test")
	if err != nil {
		t.Fatalf("Set: %v", err)
	}
	if g.FolderPath != "projects" || g.Level != mcp.TierEditOnly || g.GrantedVia != "test" {
		t.Errorf("Set returned %+v", g)
	}

	list, err := a.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 grant, got %d", len(list))
	}
	if list[0].FolderPath != "projects" || list[0].Level != mcp.TierEditOnly {
		t.Errorf("List[0] = %+v", list[0])
	}
	if list[0].GrantedVia != "test" {
		t.Errorf("GrantedVia = %q, want test", list[0].GrantedVia)
	}
	if list[0].GrantedAt.IsZero() {
		t.Error("GrantedAt should be set")
	}
}

func TestACL_Set_UpsertUpgradesTier(t *testing.T) {
	a := newACL(t)
	ctx := context.Background()

	if _, err := a.Set(ctx, "projects", mcp.TierEditOnly, "first"); err != nil {
		t.Fatalf("Set tier1: %v", err)
	}
	if _, err := a.Set(ctx, "projects", mcp.TierFull, "second"); err != nil {
		t.Fatalf("Set tier2 upgrade: %v", err)
	}

	list, err := a.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("upgrade should keep ONE row, got %d", len(list))
	}
	if list[0].Level != mcp.TierFull {
		t.Errorf("level = %d, want TierFull (2)", list[0].Level)
	}
	if list[0].GrantedVia != "second" {
		t.Errorf("granted_via = %q, want updated to %q", list[0].GrantedVia, "second")
	}
}

func TestACL_Revoke(t *testing.T) {
	a := newACL(t)
	ctx := context.Background()

	if _, err := a.Set(ctx, "projects", mcp.TierEditOnly, "x"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := a.Revoke(ctx, "projects"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	list, err := a.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("expected 0 rows after revoke, got %d", len(list))
	}

	if err := a.Revoke(ctx, "never-existed"); err != nil {
		t.Errorf("Revoke missing path returned err: %v", err)
	}
}

func TestACL_Set_RejectsInvalidInput(t *testing.T) {
	a := newACL(t)
	ctx := context.Background()

	cases := []struct {
		name  string
		path  string
		level mcp.GrantLevel
	}{
		{"level zero", "projects", 0},
		{"level three", "projects", 3},
		{"empty path", "", mcp.TierEditOnly},
		{"dot-dot path", "../etc", mcp.TierEditOnly},
		{"dot-dot mid path", "projects/../etc", mcp.TierEditOnly},
		{"whitespace only", "   ", mcp.TierEditOnly},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := a.Set(ctx, tc.path, tc.level, "test"); err == nil {
				t.Errorf("expected error for %s (path=%q level=%d), got nil", tc.name, tc.path, tc.level)
			}
		})
	}
}

func TestACL_Set_NormalizesPath(t *testing.T) {
	a := newACL(t)
	ctx := context.Background()

	g, err := a.Set(ctx, "/Projects/AI/", mcp.TierEditOnly, "wizard")
	if err != nil {
		t.Fatalf("Set: %v", err)
	}
	if g.FolderPath != "projects/ai" {
		t.Errorf("normalized FolderPath = %q, want projects/ai", g.FolderPath)
	}

	list, err := a.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 || list[0].FolderPath != "projects/ai" {
		t.Errorf("List = %+v", list)
	}
}

func TestACL_Resolve_RecursiveMostSpecificWins(t *testing.T) {
	a := newACL(t)
	ctx := context.Background()

	if _, err := a.Set(ctx, "projects", mcp.TierEditOnly, "x"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	lvl, ok := a.Resolve(ctx, "projects/ai/draft.md")
	if !ok || lvl != mcp.TierEditOnly {
		t.Errorf("Resolve under projects = (%d, %v), want (1, true)", lvl, ok)
	}

	if _, err := a.Set(ctx, "projects/ai", mcp.TierFull, "x"); err != nil {
		t.Fatalf("Set deeper: %v", err)
	}
	lvl, ok = a.Resolve(ctx, "projects/ai/draft.md")
	if !ok || lvl != mcp.TierFull {
		t.Errorf("most-specific = (%d, %v), want (2, true)", lvl, ok)
	}

	lvl, ok = a.Resolve(ctx, "daily/2026-05-17.md")
	if ok || lvl != 0 {
		t.Errorf("unrelated subtree = (%d, %v), want (0, false)", lvl, ok)
	}
}

func TestACL_Resolve_NoGrants(t *testing.T) {
	a := newACL(t)
	ctx := context.Background()
	if lvl, ok := a.Resolve(ctx, "anything/foo.md"); ok || lvl != 0 {
		t.Errorf("empty table Resolve = (%d, %v), want (0, false)", lvl, ok)
	}
}

func TestACL_Capabilities_TierEditOnly(t *testing.T) {
	a := newACL(t)
	ctx := context.Background()
	if _, err := a.Set(ctx, "projects", mcp.TierEditOnly, "x"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	notePath := "projects/x.md"
	if !a.CanCreate(ctx, notePath) {
		t.Error("CanCreate should be TRUE for Tier 1")
	}
	if !a.CanUpdate(ctx, notePath) {
		t.Error("CanUpdate should be TRUE for Tier 1")
	}
	if a.CanMove(ctx, notePath) {
		t.Error("CanMove should be FALSE for Tier 1")
	}
	if a.CanDelete(ctx, notePath) {
		t.Error("CanDelete should be FALSE for Tier 1")
	}
}

func TestACL_Capabilities_TierFull(t *testing.T) {
	a := newACL(t)
	ctx := context.Background()
	if _, err := a.Set(ctx, "projects", mcp.TierFull, "x"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	notePath := "projects/x.md"
	if !a.CanCreate(ctx, notePath) {
		t.Error("CanCreate should be TRUE for Tier 2")
	}
	if !a.CanUpdate(ctx, notePath) {
		t.Error("CanUpdate should be TRUE for Tier 2")
	}
	if !a.CanMove(ctx, notePath) {
		t.Error("CanMove should be TRUE for Tier 2")
	}
	if !a.CanDelete(ctx, notePath) {
		t.Error("CanDelete should be TRUE for Tier 2")
	}
}

func TestACL_Capabilities_NoGrant(t *testing.T) {
	a := newACL(t)
	ctx := context.Background()
	notePath := "ungranted/x.md"
	if a.CanCreate(ctx, notePath) {
		t.Error("CanCreate should be FALSE without grant")
	}
	if a.CanUpdate(ctx, notePath) {
		t.Error("CanUpdate should be FALSE without grant")
	}
	if a.CanMove(ctx, notePath) {
		t.Error("CanMove should be FALSE without grant")
	}
	if a.CanDelete(ctx, notePath) {
		t.Error("CanDelete should be FALSE without grant")
	}
}

func TestACL_NextCallRevocation(t *testing.T) {
	a := newACL(t)
	ctx := context.Background()

	if _, err := a.Set(ctx, "projects", mcp.TierEditOnly, "x"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	notePath := "projects/x.md"
	if !a.CanCreate(ctx, notePath) {
		t.Fatal("pre-revoke CanCreate should be TRUE")
	}
	if err := a.Revoke(ctx, "projects"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	if a.CanCreate(ctx, notePath) {
		t.Error("post-revoke CanCreate should be FALSE (D-24)")
	}
	if _, ok := a.Resolve(ctx, notePath); ok {
		t.Error("post-revoke Resolve should report no grant")
	}
}

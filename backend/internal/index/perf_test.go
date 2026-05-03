package index_test

// PERF-02 quantitative gate: BuildTree on a 1,000-note synthetic vault
// must complete in well under the 100ms target with response JSON below
// 500KB. The qualitative ROADMAP criterion ("no perceptible lag with a
// 1,000-note vault") is reframed here as a CI-runnable wall-clock check
// with 3× headroom for slow CI hardware. Mirrors the synthetic-vault
// pattern from stress_test.go (50 buckets × 20 notes = 1,000 notes).

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/migrations"
)

const (
	phase3PerfNoteCount   = 1000
	phase3PerfFolderCount = 50
)

// setupPhase3PerfVault builds a 1,000-note vault, opens a real
// sqlite.Pair, applies the migration runner (Path 0 — fresh boot), runs
// a full reconcile to populate the `notes` table, and returns a fully
// wired *index.Indexer plus a teardown closure that closes the pair.
//
// Accepts testing.TB so the same helper can be called from both
// TestBuildTree_PERF02_1000Notes (testing.T) and
// BenchmarkBuildTree_1000Notes (testing.B).
func setupPhase3PerfVault(tb testing.TB) (*index.Indexer, func()) {
	tb.Helper()
	tmp := tb.TempDir()
	notesDir := filepath.Join(tmp, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		tb.Fatalf("mkdir notes: %v", err)
	}

	// 50 folders × 20 notes = 1,000 notes total.
	for f := 0; f < phase3PerfFolderCount; f++ {
		folder := filepath.Join(notesDir, fmt.Sprintf("folder-%02d", f))
		if err := os.MkdirAll(folder, 0o755); err != nil {
			tb.Fatalf("mkdir folder-%02d: %v", f, err)
		}
		for n := 0; n < phase3PerfNoteCount/phase3PerfFolderCount; n++ {
			path := filepath.Join(folder, fmt.Sprintf("note-%03d.md", n))
			content := fmt.Sprintf("# Note %02d-%03d\n\nbody body body\n", f, n)
			if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
				tb.Fatalf("write note: %v", err)
			}
		}
	}

	dbPath := filepath.Join(tmp, "app.db")
	ctx := context.Background()
	pair, err := sqlite.Open(ctx, dbPath)
	if err != nil {
		tb.Fatalf("sqlite.Open: %v", err)
	}

	runner := migrate.NewRunner(migrate.RunnerOptions{
		DBPath:     dbPath,
		BackupPath: dbPath + ".backup",
		LogsPath:   filepath.Join(tmp, "jasper.log"),
		Migrations: migrations.FS,
		Pair:       pair,
		Log:        silentTestLogger(),
	})
	if _, err := runner.Run(ctx); err != nil {
		_ = pair.Close()
		tb.Fatalf("runner.Run: %v", err)
	}

	idx := index.New(pair, notesDir, silentTestLogger())
	if _, err := idx.Reconcile(ctx, index.ModeFull); err != nil {
		_ = pair.Close()
		tb.Fatalf("Reconcile(ModeFull): %v", err)
	}
	return idx, func() { _ = pair.Close() }
}

// TestBuildTree_PERF02_1000Notes asserts that BuildTree on a 1,000-note
// vault completes within 300ms wall clock (the 3× headroom budget over
// the 100ms target) and that the JSON-encoded payload stays under 500KB.
// On dev hardware the wall clock is typically well under 50ms.
func TestBuildTree_PERF02_1000Notes(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping 1000-note PERF-02 test in -short")
	}
	idx, cleanup := setupPhase3PerfVault(t)
	defer cleanup()

	ctx := context.Background()

	// Warm-up call — first invocation may pay a syscall / page-cache cost.
	if _, err := idx.BuildTree(ctx); err != nil {
		t.Fatalf("BuildTree warm-up: %v", err)
	}

	const wallClockBudget = 300 * time.Millisecond // 3× headroom over target
	const wallClockTarget = 100 * time.Millisecond // PERF-02 target

	start := time.Now()
	tree, err := idx.BuildTree(ctx)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}

	if elapsed > wallClockBudget {
		t.Errorf("BuildTree on 1000-note vault took %v (budget %v / target %v)",
			elapsed, wallClockBudget, wallClockTarget)
	}
	if elapsed > wallClockTarget {
		t.Logf("warning: BuildTree took %v (target %v) — within budget but slower than target",
			elapsed, wallClockTarget)
	}

	if len(tree.Root) < phase3PerfFolderCount {
		t.Errorf("expected at least %d top-level entries, got %d",
			phase3PerfFolderCount, len(tree.Root))
	}

	// Marshal to JSON to verify the payload is bounded. The wire encoding
	// (api.Tree) is similar enough to the index.Tree shape for the size
	// check to be a useful proxy; the wire-shape correctness is enforced
	// by the tree_handler tests in Plan 03-04.
	jsonBytes, err := json.Marshal(tree)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	const jsonBudget = 500 * 1024 // 500KB
	if len(jsonBytes) > jsonBudget {
		t.Errorf("JSON-encoded tree is %d bytes; budget %d (PERF-02 wire-payload sanity)",
			len(jsonBytes), jsonBudget)
	}
	t.Logf("PERF-02: BuildTree(1000-note vault) wall=%v, json=%dKB",
		elapsed, len(jsonBytes)/1024)
}

// BenchmarkBuildTree_1000Notes provides a regression baseline for
// BuildTree's wall clock under `go test -bench`. Setup is amortized
// outside the loop; each iteration measures BuildTree alone.
func BenchmarkBuildTree_1000Notes(b *testing.B) {
	idx, cleanup := setupPhase3PerfVault(b)
	defer cleanup()
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := idx.BuildTree(ctx); err != nil {
			b.Fatalf("BuildTree: %v", err)
		}
	}
}

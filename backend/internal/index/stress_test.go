package index_test

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/migrations"
)

// TestStress_5000Note_FullReconcile_NoBusy is the criterion-5 floor
// (ROADMAP §Performance). It creates 5,000 .md files, opens a real
// sqlite.Pair, runs the migration runner (Path 0 — fresh boot), then
// fires concurrent Reconcile + concurrent disk writers. Asserts:
//
//	(a) zero errors containing "SQLITE_BUSY" / "database is locked";
//	(b) wall-clock under 60 seconds (enforced via context.WithTimeout);
//	(c) SELECT COUNT(*) FROM notes returns 5000 after a settling full
//	    reconcile pass.
//
// The wall-clock bound + the count assertion are the W-5 strong gates
// the planner wanted: a stress test that fails the build if we ever
// regress on writer-pool serialization (DATA-03).
func TestStress_5000Note_FullReconcile_NoBusy(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping 5000-note stress test in -short")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	dataDir := t.TempDir()
	notesDir := filepath.Join(dataDir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// 1. Build 5,000 synthetic .md files. Distribute across a few
	// sub-folders so the walker exercises directory recursion.
	const N = 5000
	for i := 0; i < N; i++ {
		bucket := fmt.Sprintf("b%02d", i%50)
		name := fmt.Sprintf("note-%05d.md", i)
		dir := filepath.Join(notesDir, bucket)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		body := fmt.Sprintf("# Note %d\n\nbody body body\n", i)
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// 2. Open Pair + bootstrap schema via runner Path 0 (fresh boot).
	dbPath := filepath.Join(dataDir, "app.db")
	pair, err := sqlite.Open(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = pair.Close() }()
	runner := migrate.NewRunner(migrate.RunnerOptions{
		DBPath:     dbPath,
		BackupPath: dbPath + ".backup",
		LogsPath:   filepath.Join(dataDir, "jasper.log"),
		Migrations: migrations.FS,
		Pair:       pair,
		Log:        silentTestLogger(),
	})
	if _, err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}

	// 3. Build the indexer.
	idx := index.New(pair, notesDir, silentTestLogger())

	// 4. Concurrent reconcile + writers.
	errCh := make(chan error, 100)
	var wg sync.WaitGroup
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := idx.Reconcile(ctx, index.ModeIncremental); err != nil {
				errCh <- err
			}
		}()
	}
	// Concurrent writers updating mtimes / content on a few files.
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				idxN := (seed*100 + i) % N
				bucket := fmt.Sprintf("b%02d", idxN%50)
				name := fmt.Sprintf("note-%05d.md", idxN)
				p := filepath.Join(notesDir, bucket, name)
				body := fmt.Sprintf("# Note %d (rev %d)\n\nupdated\n", idxN, seed)
				_ = os.WriteFile(p, []byte(body), 0o644)
			}
		}(w)
	}
	wg.Wait()
	close(errCh)

	// 5. Assert: zero SQLITE_BUSY / database is locked.
	for err := range errCh {
		if err == nil {
			continue
		}
		msg := err.Error()
		if strings.Contains(msg, "SQLITE_BUSY") || strings.Contains(msg, "database is locked") {
			t.Fatalf("unexpected busy error: %v", err)
		}
		t.Fatalf("reconcile error: %v", err)
	}

	// 6. Final settle reconcile, then assert COUNT == 5000.
	if _, err := idx.Reconcile(ctx, index.ModeIncremental); err != nil {
		t.Fatalf("final settle reconcile: %v", err)
	}
	var count int
	if err := pair.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM notes`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != N {
		t.Fatalf("count == %d, want %d", count, N)
	}
}

// silentTestLogger returns a slog.Logger that discards everything; the
// stress test runs millions of log lines under load and we don't want
// to drown the test output.
func silentTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(nopWriter{}, nil))
}

// nopWriter is an io.Writer that discards everything. (We use it
// instead of io.Discard purely so this file has a tiny zero-import
// surface — io.Discard is fine, just style.)
type nopWriter struct{}

func (nopWriter) Write(p []byte) (int, error) { return len(p), nil }

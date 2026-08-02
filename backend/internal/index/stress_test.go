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

// TestStress_5000Note_FullReconcile_NoBusy fires concurrent Reconcile against
// concurrent disk writers over 5,000 files. Zero SQLITE_BUSY plus a wall-clock
// bound is what makes it fail the build on a writer-pool serialization
// regression, rather than merely getting slower.
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

	idx := index.New(pair, notesDir, silentTestLogger())

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

func silentTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(nopWriter{}, nil))
}

type nopWriter struct{}

func (nopWriter) Write(p []byte) (int, error) { return len(p), nil }

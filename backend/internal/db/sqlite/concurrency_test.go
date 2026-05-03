package sqlite

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestConcurrentWrites_5000Notes_NoBusy is the criterion-5 stress
// floor: 5,000 INSERTs distributed across runtime.NumCPU() goroutines,
// each running its own BEGIN IMMEDIATE writer transaction, while a
// pool of reader goroutines hammers SELECT COUNT(*) against the
// reader half of the Pair.
//
// Failure modes (any of these fails the test):
//   - any error message contains "SQLITE_BUSY"
//   - any error message contains "database is locked"
//   - the 60s wall-clock deadline elapses
//   - the final row count is not 5000
//
// Pass condition: zero SQLITE_BUSY, no "database is locked", final
// count == 5000, completes well under 60s on 2024-era M-series Mac.
//
// This test backs ROADMAP success criterion #5 ("5,000-note
// synthetic vault, concurrent writes, no SQLITE_BUSY") — Plan 02-04's
// runner depends on this floor working before it ships.
func TestConcurrentWrites_5000Notes_NoBusy(t *testing.T) {
	const totalNotes = 5000

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "stress.db")

	// 60s hard deadline — generous for the worst CI we'd hit; on a
	// modern M-series the test should finish in well under 30s.
	deadline := time.Now().Add(60 * time.Second)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()

	pair, err := Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() {
		if err := pair.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	}()

	// Bootstrap the schema by reading 001_initial.sql directly. This
	// avoids a circular dependency on Plan 02-03's runner — the
	// runner exercises the same file once it ships.
	schemaPath := filepath.Join("..", "..", "..", "migrations", "001_initial.sql")
	schemaBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatalf("read schema (%s): %v", schemaPath, err)
	}
	if _, err := pair.Writer.ExecContext(ctx, string(schemaBytes)); err != nil {
		t.Fatalf("apply schema: %v", err)
	}

	cpus := runtime.NumCPU()
	if cpus < 1 {
		cpus = 1
	}
	perCPU := totalNotes / cpus
	// Distribute the remainder onto the first few goroutines so we
	// always insert exactly totalNotes rows across all goroutines.
	remainder := totalNotes - (perCPU * cpus)

	var (
		writerWG    sync.WaitGroup
		errCh       = make(chan error, totalNotes)
		insertCount atomic.Int64
	)

	now := time.Now().Unix()
	startedAt := time.Now()

	// Writer goroutines.
	for c := 0; c < cpus; c++ {
		writerWG.Add(1)
		count := perCPU
		if c < remainder {
			count++
		}
		// Per-goroutine path-prefix offset to keep paths globally
		// unique (notes.path is UNIQUE; collisions would surface as
		// constraint violations).
		offset := c * 10000
		go func(start, n int) {
			defer writerWG.Done()
			for i := 0; i < n; i++ {
				tx, err := pair.BeginImmediate(ctx)
				if err != nil {
					errCh <- fmt.Errorf("BeginImmediate: %w", err)
					return
				}
				id := uuid.New().String()
				path := fmt.Sprintf("note-%07d.md", start+i)
				_, err = tx.ExecContext(ctx,
					`INSERT INTO notes(id,path,title,mtime_unix,size_bytes,checksum_sha256,created_at,updated_at)
                     VALUES (?,?,?,?,?,?,?,?)`,
					id, path, "title", now, 0, "", now, now)
				if err != nil {
					_ = tx.Rollback()
					errCh <- fmt.Errorf("insert: %w", err)
					return
				}
				if err := tx.Commit(); err != nil {
					errCh <- fmt.Errorf("commit: %w", err)
					return
				}
				insertCount.Add(1)
			}
		}(offset, count)
	}

	// Reader goroutines — proves WAL gives readers their own
	// snapshot; readers should never block on the active writer.
	readerCtx, readerCancel := context.WithCancel(ctx)
	var readerWG sync.WaitGroup
	for r := 0; r < 4; r++ {
		readerWG.Add(1)
		go func() {
			defer readerWG.Done()
			for {
				select {
				case <-readerCtx.Done():
					return
				default:
				}
				var n int
				if err := pair.Reader.QueryRowContext(readerCtx,
					"SELECT COUNT(*) FROM notes").Scan(&n); err != nil {
					if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
						return
					}
					// Reader-side errors that match the SQLITE_BUSY
					// or "database is locked" patterns are still test
					// failures — push them onto errCh.
					if isBusyErr(err) {
						errCh <- fmt.Errorf("reader busy: %w", err)
						return
					}
					// Other reader errors (e.g. closed) are tolerated
					// during shutdown; surface them as test errors only
					// if they happen mid-run.
					select {
					case <-readerCtx.Done():
						return
					default:
						errCh <- fmt.Errorf("reader: %w", err)
						return
					}
				}
			}
		}()
	}

	writerWG.Wait()
	readerCancel()
	readerWG.Wait()
	close(errCh)

	// Drain errCh; any error fails the test, with extra detail when
	// the error message mentions SQLITE_BUSY or "database is locked".
	var errs []error
	for err := range errCh {
		errs = append(errs, err)
	}
	for _, err := range errs {
		if isBusyErr(err) {
			t.Errorf("got SQLITE_BUSY / database is locked under concurrent writes: %v", err)
		} else {
			t.Errorf("unexpected error during stress: %v", err)
		}
	}
	if len(errs) > 0 {
		t.FailNow()
	}

	if got := insertCount.Load(); got != int64(totalNotes) {
		t.Errorf("insertCount = %d, want %d", got, totalNotes)
	}

	var n int
	if err := pair.Reader.QueryRowContext(ctx, "SELECT COUNT(*) FROM notes").Scan(&n); err != nil {
		t.Fatalf("final count: %v", err)
	}
	if n != totalNotes {
		t.Errorf("final SELECT COUNT(*) = %d, want %d", n, totalNotes)
	}

	elapsed := time.Since(startedAt)
	t.Logf("stress completed: %d inserts across %d goroutines in %s", totalNotes, cpus, elapsed)
	if elapsed > 60*time.Second {
		t.Errorf("stress wall-clock = %s, want < 60s", elapsed)
	}
}

// TestConcurrentWrites_BeginImmediateDoesNotDeadlockReaders proves
// that an in-flight BEGIN IMMEDIATE writer does not block readers —
// the WAL invariant. A long-running writer txn is simulated by an
// INSERT followed by a 100ms sleep; in parallel, 50 reader goroutines
// run SELECT COUNT(*) and each is asserted to complete within 50ms.
func TestConcurrentWrites_BeginImmediateDoesNotDeadlockReaders(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "wal-readers.db")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pair, err := Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = pair.Close() }()

	schemaPath := filepath.Join("..", "..", "..", "migrations", "001_initial.sql")
	schemaBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatalf("read schema: %v", err)
	}
	if _, err := pair.Writer.ExecContext(ctx, string(schemaBytes)); err != nil {
		t.Fatalf("apply schema: %v", err)
	}

	// Seed one row so SELECT COUNT(*) doesn't return 0 on the snapshot.
	now := time.Now().Unix()
	if _, err := pair.Writer.ExecContext(ctx,
		`INSERT INTO notes(id,path,title,mtime_unix,size_bytes,checksum_sha256,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
		uuid.New().String(), "seed.md", "seed", now, 0, "", now, now,
	); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Long writer txn.
	writerStarted := make(chan struct{})
	writerDone := make(chan error, 1)
	go func() {
		tx, err := pair.BeginImmediate(ctx)
		if err != nil {
			writerDone <- fmt.Errorf("BeginImmediate: %w", err)
			close(writerStarted)
			return
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO notes(id,path,title,mtime_unix,size_bytes,checksum_sha256,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?)`,
			uuid.New().String(), "during-readers.md", "x", now, 0, "", now, now,
		); err != nil {
			_ = tx.Rollback()
			writerDone <- fmt.Errorf("insert: %w", err)
			close(writerStarted)
			return
		}
		close(writerStarted) // signal writer has acquired RESERVED
		time.Sleep(100 * time.Millisecond)
		if err := tx.Commit(); err != nil {
			writerDone <- fmt.Errorf("commit: %w", err)
			return
		}
		writerDone <- nil
	}()

	<-writerStarted

	// Readers.
	const readerCount = 50
	readerErrs := make(chan error, readerCount)
	readerDone := make(chan struct{}, readerCount)
	for i := 0; i < readerCount; i++ {
		go func() {
			start := time.Now()
			var n int
			err := pair.Reader.QueryRowContext(ctx, "SELECT COUNT(*) FROM notes").Scan(&n)
			elapsed := time.Since(start)
			if err != nil {
				readerErrs <- fmt.Errorf("reader: %w", err)
				readerDone <- struct{}{}
				return
			}
			if elapsed > 50*time.Millisecond {
				readerErrs <- fmt.Errorf("reader blocked %s (>50ms)", elapsed)
			}
			readerDone <- struct{}{}
		}()
	}

	// Wait for all readers within a generous overall budget.
	for i := 0; i < readerCount; i++ {
		select {
		case <-readerDone:
		case <-time.After(5 * time.Second):
			t.Fatalf("reader goroutine #%d did not return within 5s", i)
		}
	}
	close(readerErrs)

	if err := <-writerDone; err != nil {
		t.Errorf("writer error: %v", err)
	}
	for err := range readerErrs {
		t.Errorf("reader-blocking error: %v", err)
	}
}

// isBusyErr reports whether err's message mentions SQLITE_BUSY or
// "database is locked" — the two strings the modernc.org/sqlite
// driver surfaces when contention exceeds busy_timeout=5000ms.
func isBusyErr(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	if strings.Contains(msg, "SQLITE_BUSY") {
		return true
	}
	if strings.Contains(strings.ToLower(msg), "database is locked") {
		return true
	}
	return false
}

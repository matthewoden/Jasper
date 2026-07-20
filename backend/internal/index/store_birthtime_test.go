package index

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestReconcile_BirthtimeUnix_PersistsAndIsIdempotent verifies both full
// and incremental reconcile paths persist a real filesystem birthtime (or
// the deterministic D-04 zero-sentinel) into notes.birthtime_unix, and
// that a second reconcile pass does not change the stored value — the
// whole point of D-03 surviving an index wipe/rebuild.
func TestReconcile_BirthtimeUnix_PersistsAndIsIdempotent(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "a.md", "# Alpha", mtime)

	// Ground truth: what this machine's birthtimeFromPath actually reports
	// for a.md, independent of the store/reconcile wiring under test.
	aAbsPath := filepath.Join(notesDir, "a.md")
	aInfo, err := os.Stat(aAbsPath)
	if err != nil {
		t.Fatalf("stat a.md: %v", err)
	}
	wantBirthtime, wantOK := birthtimeFromPath(aAbsPath, aInfo)

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("full reconcile: %v", err)
	}
	first := queryBirthtimeUnix(t, idx, "a.md")

	if wantOK {
		if first != wantBirthtime {
			t.Errorf("stored birthtime_unix=%d does not match birthtimeFromPath()=%d (platform reports btime)", first, wantBirthtime)
		}
	} else if first != 0 {
		t.Errorf("expected birthtime_unix=0 (platform cannot report btime), got %d", first)
	}

	// Pitfall 3: newly-added notes on the INCREMENTAL path must also
	// capture a real birthtime, not be left at the 0 sentinel forever.
	writeNote(t, notesDir, "b.md", "# Bravo", mtime)
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatalf("incremental reconcile: %v", err)
	}
	bIncrementalBirthtime := queryBirthtimeUnix(t, idx, "b.md")

	// Idempotence: re-running full reconcile must not change a.md's
	// already-stored birthtime_unix.
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("second full reconcile: %v", err)
	}
	second := queryBirthtimeUnix(t, idx, "a.md")

	if first != second {
		t.Errorf("birthtime_unix changed across reconcile runs: got %d then %d", first, second)
	}

	// Both notes share the same temp-dir filesystem, so both must follow
	// the same birthtimeFromPath sentinel contract (either both real >0,
	// or both the deterministic 0 fallback) — a mismatch would mean the
	// incremental path isn't calling the helper at all.
	if (first == 0) != (bIncrementalBirthtime == 0) {
		t.Errorf("full vs incremental birthtime sentinel mismatch: a.md=%d b.md=%d", first, bIncrementalBirthtime)
	}
}

func queryBirthtimeUnix(t *testing.T, idx *Indexer, path string) int64 {
	t.Helper()
	var v int64
	if err := idx.Pair.Reader.QueryRowContext(context.Background(),
		`SELECT birthtime_unix FROM notes WHERE path = ?`, path).Scan(&v); err != nil {
		t.Fatalf("query birthtime_unix for %q: %v", path, err)
	}
	return v
}

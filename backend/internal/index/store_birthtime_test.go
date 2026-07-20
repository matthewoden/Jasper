package index

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
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

// TestReconcileIncremental_BackfillsZeroBirthtime_ForUpToDateRows is the
// WR-04 regression: migration 006 leaves every pre-existing row at the 0
// sentinel, and the startup incremental reconcile used to skip any file
// whose mtime matched the index — so upgraded vaults never captured a
// birthtime and the "created" sort silently ran on first-seen timestamps.
// The skip branch must heal the sentinel using the walk's already-statted
// birthtime.
func TestReconcileIncremental_BackfillsZeroBirthtime_ForUpToDateRows(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "old.md", "# Old", mtime)

	absPath := filepath.Join(notesDir, "old.md")
	info, err := os.Stat(absPath)
	if err != nil {
		t.Fatalf("stat old.md: %v", err)
	}
	wantBirthtime, wantOK := birthtimeFromPath(absPath, info)
	if !wantOK {
		t.Skip("platform does not report birthtime; backfill is a deterministic no-op here")
	}

	// Simulate the pre-phase-29 index row: mtime matches disk (so the
	// incremental walk takes the skip branch), birthtime at the 0 sentinel.
	rec := notes.NoteRecord{
		ID:            uuid.New(),
		Path:          "old.md",
		Title:         "Old",
		MTimeUnix:     mtime.Unix(),
		SizeBytes:     info.Size(),
		UpdatedAtUnix: mtime.Unix(),
		BodyFTS:       "Old",
	}
	if err := idx.Upsert(context.Background(), rec); err != nil {
		t.Fatalf("seed upsert: %v", err)
	}
	if got := queryBirthtimeUnix(t, idx, "old.md"); got != 0 {
		t.Fatalf("precondition: birthtime_unix = %d, want 0 sentinel", got)
	}

	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatalf("incremental reconcile: %v", err)
	}
	if got := queryBirthtimeUnix(t, idx, "old.md"); got != wantBirthtime {
		t.Errorf("birthtime_unix after incremental reconcile = %d, want backfilled %d", got, wantBirthtime)
	}
}

// TestUpsert_ZeroBirthtime_DoesNotClobberStored is the CR-01 regression:
// Service.Update builds its NoteRecord with BirthtimeUnix left at the zero
// sentinel (the API save path has no cheap access to the on-disk birthtime).
// Upsert's ON CONFLICT clause must therefore treat excluded.birthtime_unix=0
// as "unknown — keep what we have", not as a value to store. A real positive
// birthtime (reconcile refresh) must still win.
func TestUpsert_ZeroBirthtime_DoesNotClobberStored(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	// Reconcile-equivalent seeding: alpha birthtime=5000, gamma birthtime=4000.
	alpha := upsertSortFixtureNote(t, idx, "alpha.md", "Alpha", "alpha widget note", 1000, 5000)
	gamma := upsertSortFixtureNote(t, idx, "gamma.md", "Gamma", "gamma widget note", 3000, 4000)

	// Interactive save of alpha (PUT /notes/{id} shape): same id/path, newer
	// mtime/updated_at, BirthtimeUnix zero value.
	edited := notes.NoteRecord{
		ID:            alpha,
		Path:          "alpha.md",
		Title:         "Alpha",
		MTimeUnix:     6000,
		SizeBytes:     43,
		UpdatedAtUnix: 6000,
		BodyFTS:       "alpha widget note edited",
	}
	if err := idx.Upsert(context.Background(), edited); err != nil {
		t.Fatalf("upsert edited alpha: %v", err)
	}

	if got := queryBirthtimeUnix(t, idx, "alpha.md"); got != 5000 {
		t.Errorf("birthtime_unix after zero-birthtime upsert = %d; want stored 5000 preserved", got)
	}

	// The user-visible symptom: sort=created must still rank alpha (birth
	// 5000) above gamma (birth 4000) after the edit. With the clobber, alpha
	// falls back to created_at=1000 and sorts last.
	hits, err := idx.SearchFTS(context.Background(), "widget", nil, 50, "created")
	if err != nil {
		t.Fatalf("SearchFTS(sort=created): %v", err)
	}
	assertHitOrder(t, hits, []uuid.UUID{alpha, gamma})

	// A real positive birthtime (full-reconcile refresh) must still update.
	refreshed := edited
	refreshed.BirthtimeUnix = 7000
	if err := idx.Upsert(context.Background(), refreshed); err != nil {
		t.Fatalf("upsert refreshed alpha: %v", err)
	}
	if got := queryBirthtimeUnix(t, idx, "alpha.md"); got != 7000 {
		t.Errorf("birthtime_unix after positive-birthtime upsert = %d; want refreshed 7000", got)
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

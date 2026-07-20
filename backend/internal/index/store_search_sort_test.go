package index

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// upsertSortFixtureNote inserts a note with an explicit updated_at/birthtime
// pairing so SearchFTS sort-order tests can assert exact orderings. body is
// the FTS-indexed content; pass "" for a note that must NOT match an FTS
// MATCH query (used by the Pitfall-4 fallback-skip fixture).
func upsertSortFixtureNote(t *testing.T, idx *Indexer, path, title, body string, updatedAtUnix, birthtimeUnix int64) uuid.UUID {
	t.Helper()
	id := uuid.New()
	rec := notes.NoteRecord{
		ID:            id,
		Path:          path,
		Title:         title,
		MTimeUnix:     updatedAtUnix,
		SizeBytes:     42,
		UpdatedAtUnix: updatedAtUnix,
		BodyFTS:       body,
		BirthtimeUnix: birthtimeUnix,
	}
	if err := idx.Upsert(context.Background(), rec); err != nil {
		t.Fatalf("upsert(%q): %v", path, err)
	}
	return id
}

// TestSearchFTS_SortModified — three notes all matching "widget"; SearchFTS
// with sort="modified" must order by n.updated_at DESC across the full
// match set, independent of birthtime/created_at.
func TestSearchFTS_SortModified(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	a := upsertSortFixtureNote(t, idx, "alpha.md", "Alpha", "alpha widget note", 1000, 5000)
	b := upsertSortFixtureNote(t, idx, "beta.md", "Beta", "beta widget note", 2000, 0)
	c := upsertSortFixtureNote(t, idx, "gamma.md", "Gamma", "gamma widget note", 3000, 1000)

	hits, err := idx.SearchFTS(context.Background(), "widget", nil, 50, "modified")
	if err != nil {
		t.Fatalf("SearchFTS(sort=modified): %v", err)
	}
	wantOrder := []uuid.UUID{c, b, a} // updated_at DESC: 3000, 2000, 1000
	assertHitOrder(t, hits, wantOrder)
}

// TestSearchFTS_SortCreated — same three notes; sort="created" must order by
// COALESCE(NULLIF(birthtime_unix,0), created_at) DESC — a DIFFERENT order
// from "modified" here, proving the created sort reads birthtime (not
// updated_at), and note "beta" (birthtime=0) falls back to its created_at
// (D-04's per-file fallback), never to mtime.
func TestSearchFTS_SortCreated(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	a := upsertSortFixtureNote(t, idx, "alpha.md", "Alpha", "alpha widget note", 1000, 5000)
	b := upsertSortFixtureNote(t, idx, "beta.md", "Beta", "beta widget note", 2000, 0) // birthtime=0 -> falls back to created_at=2000
	c := upsertSortFixtureNote(t, idx, "gamma.md", "Gamma", "gamma widget note", 3000, 1000)

	hits, err := idx.SearchFTS(context.Background(), "widget", nil, 50, "created")
	if err != nil {
		t.Fatalf("SearchFTS(sort=created): %v", err)
	}
	// COALESCE created DESC: alpha=5000, beta(fallback)=2000, gamma=1000
	wantOrder := []uuid.UUID{a, b, c}
	assertHitOrder(t, hits, wantOrder)

	for _, h := range hits {
		if h.ID == b.String() && h.CreatedAt.Unix() != 2000 {
			t.Fatalf("beta (birthtime_unix=0) CreatedAt = %v (unix %d); want fallback to created_at=2000",
				h.CreatedAt, h.CreatedAt.Unix())
		}
		if h.ID == a.String() && h.CreatedAt.Unix() != 5000 {
			t.Fatalf("alpha CreatedAt = %v (unix %d); want birthtime_unix=5000", h.CreatedAt, h.CreatedAt.Unix())
		}
	}
}

// TestSearchFTS_SortRelevanceUnchanged — sort="relevance" and sort="" must
// behave identically to each other (both = the existing bm25 + recency
// blend), and must return the same hit set as before this plan's changes.
func TestSearchFTS_SortRelevanceUnchanged(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	a := upsertSortFixtureNote(t, idx, "alpha.md", "Alpha", "alpha widget note", 1000, 5000)
	b := upsertSortFixtureNote(t, idx, "beta.md", "Beta", "beta widget note", 2000, 0)
	c := upsertSortFixtureNote(t, idx, "gamma.md", "Gamma", "gamma widget note", 3000, 1000)

	relevanceHits, err := idx.SearchFTS(context.Background(), "widget", nil, 50, "relevance")
	if err != nil {
		t.Fatalf("SearchFTS(sort=relevance): %v", err)
	}
	defaultHits, err := idx.SearchFTS(context.Background(), "widget", nil, 50, "")
	if err != nil {
		t.Fatalf("SearchFTS(sort=\"\"): %v", err)
	}

	wantIDs := map[string]bool{a.String(): true, b.String(): true, c.String(): true}
	assertSameIDOrder(t, relevanceHits, defaultHits)
	for _, h := range relevanceHits {
		if !wantIDs[h.ID] {
			t.Fatalf("SearchFTS(sort=relevance): unexpected hit %+v", h)
		}
	}
	if len(relevanceHits) != 3 {
		t.Fatalf("SearchFTS(sort=relevance): got %d hits, want 3", len(relevanceHits))
	}
}

// TestSearchFTS_SortSkipsLikeFallback — Pitfall 4 (RESEARCH): for
// sort in {modified, created}, the title-LIKE fallback merge must be
// skipped entirely so no out-of-order tail row appears. "widget-fallback.md"
// has an EMPTY body (no FTS match for "widget") but its title/path DO
// contain "widget" — under sort=relevance this note is picked up by the
// title-LIKE fallback (since the 3 real FTS hits are <= limit); under
// sort=modified/created it must NOT appear at all.
func TestSearchFTS_SortSkipsLikeFallback(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	a := upsertSortFixtureNote(t, idx, "alpha.md", "Alpha", "alpha widget note", 1000, 5000)
	b := upsertSortFixtureNote(t, idx, "beta.md", "Beta", "beta widget note", 2000, 0)
	c := upsertSortFixtureNote(t, idx, "gamma.md", "Gamma", "gamma widget note", 3000, 1000)
	fallback := upsertSortFixtureNote(t, idx, "widget-fallback.md", "Widget Fallback", "", 500, 500)

	relevanceHits, err := idx.SearchFTS(context.Background(), "widget", nil, 50, "relevance")
	if err != nil {
		t.Fatalf("SearchFTS(sort=relevance): %v", err)
	}
	foundFallback := false
	for _, h := range relevanceHits {
		if h.ID == fallback.String() {
			foundFallback = true
		}
	}
	if !foundFallback {
		t.Fatalf("SearchFTS(sort=relevance): expected title-LIKE fallback to include %s (precondition for this test)", fallback)
	}

	for _, sort := range []string{"modified", "created"} {
		hits, err := idx.SearchFTS(context.Background(), "widget", nil, 50, sort)
		if err != nil {
			t.Fatalf("SearchFTS(sort=%s): %v", sort, err)
		}
		if len(hits) != 3 {
			t.Fatalf("SearchFTS(sort=%s): got %d hits, want exactly 3 (fallback must be skipped, no out-of-order tail)", sort, len(hits))
		}
		for _, h := range hits {
			if h.ID == fallback.String() {
				t.Fatalf("SearchFTS(sort=%s): title-LIKE fallback row %s leaked into a time-sorted result (Pitfall 4)", sort, fallback)
			}
		}
	}
	_ = a
	_ = b
	_ = c
}

func assertHitOrder(t *testing.T, hits []notes.SearchHit, want []uuid.UUID) {
	t.Helper()
	if len(hits) != len(want) {
		t.Fatalf("assertHitOrder: got %d hits, want %d (%+v)", len(hits), len(want), hits)
	}
	for i, h := range hits {
		if h.ID != want[i].String() {
			var gotIDs []string
			for _, g := range hits {
				gotIDs = append(gotIDs, g.ID)
			}
			var wantIDs []string
			for _, w := range want {
				wantIDs = append(wantIDs, w.String())
			}
			t.Fatalf("assertHitOrder: at index %d got %s, want %s\ngot order:  %v\nwant order: %v",
				i, h.ID, want[i], gotIDs, wantIDs)
		}
	}
}

func assertSameIDOrder(t *testing.T, a, b []notes.SearchHit) {
	t.Helper()
	if len(a) != len(b) {
		t.Fatalf("assertSameIDOrder: length mismatch %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i].ID != b[i].ID {
			t.Fatalf("assertSameIDOrder: at index %d got %s vs %s", i, a[i].ID, b[i].ID)
		}
	}
}

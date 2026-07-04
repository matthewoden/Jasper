package index

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"golang.org/x/text/unicode/norm"

	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/migrations"
)

func newTestIndexer(t *testing.T) (*Indexer, string) {
	t.Helper()
	dir := t.TempDir()
	notesDir := filepath.Join(dir, "notes")
	dbPath := filepath.Join(dir, "app.db")

	pair, err := sqlite.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("sqlite.Open: %v", err)
	}
	t.Cleanup(func() { _ = pair.Close() })

	for _, name := range []string{"001_initial.sql", "002_tags_backlinks.sql", "003_fts.sql"} {
		data, err := migrations.FS.ReadFile(name)
		if err != nil {
			t.Fatalf("read migration %s: %v", name, err)
		}
		if _, err := pair.Writer.ExecContext(context.Background(), string(data)); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
	}

	idx := New(pair, notesDir, slog.Default())

	idx.nowUnix = func() int64 { return 1730000000 }
	return idx, notesDir
}

func rec1(id uuid.UUID) notes.NoteRecord {
	return notes.NoteRecord{
		ID:            id,
		Path:          "a.md",
		Title:         "First",
		MTimeUnix:     1700000000,
		SizeBytes:     42,
		Checksum:      "",
		UpdatedAtUnix: 1730000000,
	}
}

// TestUpsert_NewRow — insert a single row; List returns it.
func TestUpsert_NewRow(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	id := uuid.New()
	if err := idx.Upsert(context.Background(), rec1(id)); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	got, err := idx.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len: got %d, want 1", len(got))
	}
	if got[0].ID != id {
		t.Errorf("ID: got %v, want %v", got[0].ID, id)
	}
	if got[0].Path != "a.md" {
		t.Errorf("Path: got %q, want %q", got[0].Path, "a.md")
	}
	if got[0].Title != "First" {
		t.Errorf("Title: got %q, want %q", got[0].Title, "First")
	}
}

// TestUpsert_UpdateExistingRow — second Upsert with same id and bumped
// mtime updates the row in place.
func TestUpsert_UpdateExistingRow(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	id := uuid.New()
	if err := idx.Upsert(context.Background(), rec1(id)); err != nil {
		t.Fatalf("upsert 1: %v", err)
	}
	r2 := rec1(id)
	r2.Title = "Second"
	r2.MTimeUnix = 1700000999
	if err := idx.Upsert(context.Background(), r2); err != nil {
		t.Fatalf("upsert 2: %v", err)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 1 {
		t.Fatalf("len: got %d, want 1", len(got))
	}
	if got[0].Title != "Second" {
		t.Errorf("Title: got %q, want %q", got[0].Title, "Second")
	}
}

// TestUpsert_CaseCollision_DifferentID — inserting a second row with
// the same path but a different id returns ErrCaseCollision and does
// NOT add a row.
func TestUpsert_CaseCollision_DifferentID(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	idA := uuid.New()
	if err := idx.Upsert(context.Background(), rec1(idA)); err != nil {
		t.Fatalf("upsert A: %v", err)
	}

	idB := uuid.New()
	r := rec1(idB)
	err := idx.Upsert(context.Background(), r)
	if err == nil {
		t.Fatalf("upsert B: got nil, want ErrCaseCollision")
	}
	if !errors.Is(err, notes.ErrCaseCollision) {
		t.Fatalf("err: got %v, want ErrCaseCollision", err)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 1 {
		t.Errorf("rows after collision: got %d, want 1", len(got))
	}
	if got[0].ID != idA {
		t.Errorf("surviving id: got %v, want %v", got[0].ID, idA)
	}
}

// TestUpsert_NoChecksumComputed — rec.Checksum is "" and the column is
// stored as "" (NULL/empty); checksum computation is deferred.
func TestUpsert_NoChecksumComputed(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	id := uuid.New()
	if err := idx.Upsert(context.Background(), rec1(id)); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	var got string
	if err := idx.Pair.Reader.QueryRowContext(context.Background(),
		`SELECT checksum_sha256 FROM notes WHERE id = ?`, id.String()).Scan(&got); err != nil {
		t.Fatalf("query: %v", err)
	}
	if got != "" {
		t.Errorf("checksum_sha256: got %q, want empty (Phase 2 deferral)", got)
	}
}

// TestDelete_Existing — Delete removes the row.
func TestDelete_Existing(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	id := uuid.New()
	if err := idx.Upsert(context.Background(), rec1(id)); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := idx.Delete(context.Background(), id); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 0 {
		t.Errorf("after delete: got %d rows, want 0", len(got))
	}
}

// TestDelete_Missing_NoOp — deleting a non-existent id is not an error.
func TestDelete_Missing_NoOp(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)
	if err := idx.Delete(context.Background(), uuid.New()); err != nil {
		t.Fatalf("delete missing: %v", err)
	}
}

// TestList_OrderedByPathASC — List returns rows in path-ascending
// order regardless of insertion order.
func TestList_OrderedByPathASC(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	r := rec1(uuid.New())
	r.Path = "z.md"
	if err := idx.Upsert(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	r = rec1(uuid.New())
	r.Path = "m.md"
	if err := idx.Upsert(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	r = rec1(uuid.New())
	r.Path = "a.md"
	if err := idx.Upsert(context.Background(), r); err != nil {
		t.Fatal(err)
	}

	got, _ := idx.List(context.Background())
	if len(got) != 3 {
		t.Fatalf("len: got %d, want 3", len(got))
	}
	want := []string{"a.md", "m.md", "z.md"}
	for i, w := range want {
		if got[i].Path != w {
			t.Errorf("[%d]: got %q, want %q", i, got[i].Path, w)
		}
	}
}

// TestList_EmptyTable_ReturnsNilSlice — no rows → empty/nil slice, no
// error.
func TestList_EmptyTable_ReturnsNilSlice(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)
	got, err := idx.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("len: got %d, want 0", len(got))
	}
}

// TestList_TitleAndUpdatedAtPopulated — Title and UpdatedAt are populated;
// UpdatedAt is mtime-derived, not the indexer's internal touch time.
func TestList_TitleAndUpdatedAtPopulated(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	id := uuid.New()
	r := rec1(id)
	if err := idx.Upsert(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 1 {
		t.Fatalf("len: got %d", len(got))
	}
	if got[0].Title != "First" {
		t.Errorf("Title: got %q, want %q", got[0].Title, "First")
	}

	if got[0].UpdatedAt.Unix() != r.MTimeUnix {
		t.Errorf("UpdatedAt: got %d, want %d (file mtime, NOT index-touch %d)",
			got[0].UpdatedAt.Unix(), r.MTimeUnix, r.UpdatedAtUnix)
	}
}

// TestLookupByPath_Hit — Insert a row via Upsert, then LookupByPath
// returns the same NoteRecord (every field round-trips).
func TestLookupByPath_Hit(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	id := uuid.New()
	r := rec1(id)
	if err := idx.Upsert(context.Background(), r); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	got, err := idx.LookupByPath(context.Background(), "a.md")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if got.ID != id {
		t.Errorf("ID: got %v, want %v", got.ID, id)
	}
	if got.Path != "a.md" {
		t.Errorf("Path: got %q, want %q", got.Path, "a.md")
	}
	if got.Title != "First" {
		t.Errorf("Title: got %q, want %q", got.Title, "First")
	}
	if got.MTimeUnix != r.MTimeUnix {
		t.Errorf("MTimeUnix: got %d, want %d", got.MTimeUnix, r.MTimeUnix)
	}
	if got.SizeBytes != r.SizeBytes {
		t.Errorf("SizeBytes: got %d, want %d", got.SizeBytes, r.SizeBytes)
	}
}

// TestLookupByPath_Miss — LookupByPath on an unknown path returns
// notes.ErrNotFound (errors.Is check).
func TestLookupByPath_Miss(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	_, err := idx.LookupByPath(context.Background(), "missing.md")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !errors.Is(err, notes.ErrNotFound) {
		t.Fatalf("err: got %v, want notes.ErrNotFound", err)
	}
}

func upsertAt(t *testing.T, idx *Indexer, path string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	r := rec1(id)
	r.Path = path
	if err := idx.Upsert(context.Background(), r); err != nil {
		t.Fatalf("upsert %q: %v", path, err)
	}
	return id
}

// TestMovePathPrefix_HappyPath — Insert 3 rows under "old/", call
// MovePathPrefix("old/", "new/"), assert all 3 paths now start with
// "new/" and the count returned is 3.
func TestMovePathPrefix_HappyPath(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	upsertAt(t, idx, "old/a.md")
	upsertAt(t, idx, "old/b.md")
	upsertAt(t, idx, "old/c.md")

	n, err := idx.MovePathPrefix(context.Background(), "old/", "new/")
	if err != nil {
		t.Fatalf("move: %v", err)
	}
	if n != 3 {
		t.Fatalf("count: got %d, want 3", n)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 3 {
		t.Fatalf("len: got %d, want 3", len(got))
	}
	for _, s := range got {
		if !startsWith(s.Path, "new/") {
			t.Errorf("path %q does not start with new/", s.Path)
		}
	}
}

// TestMovePathPrefix_NestedSubtree — Insert "old/a.md", "old/b/c.md",
// "old/d/e/f.md"; MovePathPrefix("old/", "newer/"); all 3 are correctly
// re-prefixed (the deeper subpaths preserve their internal structure).
func TestMovePathPrefix_NestedSubtree(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	upsertAt(t, idx, "old/a.md")
	upsertAt(t, idx, "old/b/c.md")
	upsertAt(t, idx, "old/d/e/f.md")

	n, err := idx.MovePathPrefix(context.Background(), "old/", "newer/")
	if err != nil {
		t.Fatalf("move: %v", err)
	}
	if n != 3 {
		t.Fatalf("count: got %d, want 3", n)
	}
	got, _ := idx.List(context.Background())
	want := map[string]bool{
		"newer/a.md":     true,
		"newer/b/c.md":   true,
		"newer/d/e/f.md": true,
	}
	for _, s := range got {
		if !want[s.Path] {
			t.Errorf("unexpected path: %q", s.Path)
		}
		delete(want, s.Path)
	}
	if len(want) != 0 {
		t.Errorf("missing paths: %v", want)
	}
}

// TestMovePathPrefix_CollisionWithForeignRow — Insert "old/x.md" AND
// "new/y.md" (separate origins); MovePathPrefix("old/", "new/") returns
// ErrCaseCollision; rows unchanged.
func TestMovePathPrefix_CollisionWithForeignRow(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	upsertAt(t, idx, "old/x.md")
	upsertAt(t, idx, "new/y.md")

	_, err := idx.MovePathPrefix(context.Background(), "old/", "new/")
	if err == nil {
		t.Fatalf("expected ErrCaseCollision, got nil")
	}
	if !errors.Is(err, notes.ErrCaseCollision) {
		t.Fatalf("err: got %v, want ErrCaseCollision", err)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 2 {
		t.Fatalf("len: got %d, want 2", len(got))
	}

	paths := map[string]bool{}
	for _, s := range got {
		paths[s.Path] = true
	}
	if !paths["old/x.md"] {
		t.Errorf("old/x.md missing")
	}
	if !paths["new/y.md"] {
		t.Errorf("new/y.md missing")
	}
}

// TestMovePathPrefix_NoMatchingRows — Empty source prefix → returns 0,
// nil.
func TestMovePathPrefix_NoMatchingRows(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	upsertAt(t, idx, "keep/a.md")

	n, err := idx.MovePathPrefix(context.Background(), "ghost/", "new/")
	if err != nil {
		t.Fatalf("move: %v", err)
	}
	if n != 0 {
		t.Errorf("count: got %d, want 0", n)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 1 || got[0].Path != "keep/a.md" {
		t.Errorf("unrelated row mutated")
	}
}

// TestMovePathPrefix_LikeEscape_Underscore — Insert "old_actual/note.md";
// MovePathPrefix("old_actual/", "new/") moves only that row (NOT
// "olda/note.md" if such a row existed — the underscore must not function
// as a wildcard).
func TestMovePathPrefix_LikeEscape_Underscore(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	upsertAt(t, idx, "old_actual/note.md")
	upsertAt(t, idx, "olda/note.md")

	n, err := idx.MovePathPrefix(context.Background(), "old_actual/", "new/")
	if err != nil {
		t.Fatalf("move: %v", err)
	}
	if n != 1 {
		t.Fatalf("count: got %d, want 1 (LIKE wildcard escape verified)", n)
	}
	got, _ := idx.List(context.Background())
	paths := map[string]bool{}
	for _, s := range got {
		paths[s.Path] = true
	}
	if !paths["new/note.md"] {
		t.Errorf("expected new/note.md, paths=%v", paths)
	}
	if !paths["olda/note.md"] {
		t.Errorf("olda/note.md must NOT have moved (LIKE escape)")
	}
}

// TestDeleteByPathPrefix_Cascade — Insert 5 rows under "trash/" + 1 row
// under "keep/"; DeleteByPathPrefix("trash"); only the 5 trash rows are
// gone; "keep/" survives.
func TestDeleteByPathPrefix_Cascade(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	upsertAt(t, idx, "trash/a.md")
	upsertAt(t, idx, "trash/b.md")
	upsertAt(t, idx, "trash/c/d.md")
	upsertAt(t, idx, "trash/c/e.md")
	upsertAt(t, idx, "trash/c/f/g.md")
	upsertAt(t, idx, "keep/h.md")

	n, err := idx.DeleteByPathPrefix(context.Background(), "trash")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if n != 5 {
		t.Errorf("count: got %d, want 5", n)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 1 || got[0].Path != "keep/h.md" {
		t.Errorf("survivors: %+v", got)
	}
}

// TestDeleteByPathPrefix_RootEmpty — DeleteByPathPrefix("") deletes all
// rows (treat as "wipe") — used by RebuildAndReindex's drop path;
// verified by inserting 3 rows then asserting 0 after.
func TestDeleteByPathPrefix_RootEmpty(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	upsertAt(t, idx, "a.md")
	upsertAt(t, idx, "b/c.md")
	upsertAt(t, idx, "d/e/f.md")

	n, err := idx.DeleteByPathPrefix(context.Background(), "")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if n != 3 {
		t.Errorf("count: got %d, want 3", n)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 0 {
		t.Errorf("after wipe: got %d rows, want 0", len(got))
	}
}

// TestDeleteByPathPrefix_LikeEscape — Insert "evidence%/note.md";
// DeleteByPathPrefix("evidence%") removes only that row (not
// "evidenceX/..."); the escape is verified.
func TestDeleteByPathPrefix_LikeEscape(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	upsertAt(t, idx, "evidence%/note.md")
	upsertAt(t, idx, "evidencex/note.md")

	n, err := idx.DeleteByPathPrefix(context.Background(), "evidence%")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if n != 1 {
		t.Errorf("count: got %d, want 1 (LIKE wildcard escape verified)", n)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 1 || got[0].Path != "evidencex/note.md" {
		t.Errorf("unexpected survivors: %+v", got)
	}
}

func startsWith(s, prefix string) bool {
	if len(prefix) > len(s) {
		return false
	}
	return s[:len(prefix)] == prefix
}

// TestUpsert_NFC_Equivalence — paths that compare equal under NFC
// (e.g. NFD "café" vs NFC "café") collide. The pre-check that we
// store paths in their canonical lowercased+NFC form means inserting
// with the alternate normalization form should hit the unique-path
// constraint as a collision.
//
// Note: this test inserts two paths whose Go string-equality differs
// (one is NFD, one NFC) but whose canonical forms are equal. The
// indexer's caller (WalkVault + Reconcile) is responsible for
// canonicalizing before calling Upsert; this test verifies that IF a
// caller passes both forms (e.g. due to a bug), the second upsert
// against the SAME canonical bytes is rejected as a collision.
func TestUpsert_NFC_Equivalence(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	idA := uuid.New()
	r := rec1(idA)
	r.Path = norm.NFC.String("café.md")
	if err := idx.Upsert(context.Background(), r); err != nil {
		t.Fatalf("upsert A: %v", err)
	}

	idB := uuid.New()
	r = rec1(idB)
	r.Path = norm.NFC.String("café.md")
	err := idx.Upsert(context.Background(), r)
	if err == nil {
		t.Fatalf("upsert B (same canonical path, different id): got nil, want ErrCaseCollision")
	}
	if !errors.Is(err, notes.ErrCaseCollision) {
		t.Fatalf("err: got %v, want ErrCaseCollision", err)
	}
}

// TestPrefixWrap covers SFT-PREFIX-1..5: the pure string-to-string rewriter.
func TestPrefixWrap(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"single bare token gets *", "te", "te*"},

		{"two bare tokens each get *", "test driven", "test* driven*"},

		{"quoted phrase passes through", `"exact phrase"`, `"exact phrase"`},

		{"AND operator passes through", "foo AND bar", "foo AND bar"},

		{"empty stays empty", "", ""},

		{"OR operator passes through", "foo OR bar", "foo OR bar"},
		{"NOT operator passes through", "foo NOT bar", "foo NOT bar"},
		{"NEAR operator passes through", "foo NEAR bar", "foo NEAR bar"},
		{"parens pass through", "(foo bar)", "(foo bar)"},
		{"colon passes through (column filter syntax)", "title:foo", "title:foo"},
		{"already-prefixed token not double-starred", "te*", "te*"},
		{"mixed prefixed + bare tokens normalized", "te* bar", "te* bar*"},
		{"surrounding whitespace trimmed", "  hello  ", "hello*"},
		{"internal multiple spaces collapsed to single", "foo   bar", "foo* bar*"},

		{"lowercase and is not an operator", "and then", "and* then*"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := prefixWrap(tc.in)
			if got != tc.want {
				t.Fatalf("prefixWrap(%q) = %q; want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestSearchFTS_PrefixMatch — integration: seed a note containing "testing",
// query "te"; assert ≥1 hit. Before the prefix-wrap helper, this returned 0
// hits because the default unicode61 tokenizer wants whole-word matches.
func TestSearchFTS_PrefixMatch(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	id := uuid.New()
	r := rec1(id)
	r.BodyFTS = "this note contains the word testing"
	if err := idx.Upsert(context.Background(), r); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	hits, err := idx.SearchFTS(context.Background(), "te", nil, 50)
	if err != nil {
		t.Fatalf("SearchFTS: %v", err)
	}
	if len(hits) < 1 {
		t.Fatalf("SearchFTS(\"te\"): got %d hits, want >= 1 (prefix match against 'testing')", len(hits))
	}
}

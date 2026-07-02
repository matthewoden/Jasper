package index

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// TestSyncBacklinks_ResolvedTarget — source links to one resolved target (F1).
func TestSyncBacklinks_ResolvedTarget(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	sourceID := newNoteID(t, idx, "notes/source.md", 1700000001)
	fooID := newNoteID(t, idx, "notes/foo.md", 1700000002)

	reg := &notes.Registry{}
	reg.Hydrate([]notes.NoteSummary{
		{ID: fooID, Path: "notes/foo.md", Title: "foo"},
	})

	refs := []markdown.WikiLinkRef{{Target: "Foo"}}
	content := []byte("Linking to [[Foo]] here.\n")

	if err := idx.SyncBacklinks(ctx, sourceID, "notes/source.md", refs, reg, content); err != nil {
		t.Fatalf("SyncBacklinks: %v", err)
	}

	var targetIDStr string
	var targetTitle string
	var excerpt string
	if err := idx.Pair.Reader.QueryRowContext(
		ctx,
		`SELECT COALESCE(target_id, ''), target_title, excerpt
		 FROM backlinks WHERE source_id = ?`, sourceID.String(),
	).Scan(&targetIDStr, &targetTitle, &excerpt); err != nil {
		t.Fatalf("query backlinks: %v", err)
	}
	if targetIDStr != fooID.String() {
		t.Errorf("target_id: got %q, want %q", targetIDStr, fooID.String())
	}
	if targetTitle != "Foo" {
		t.Errorf("target_title: got %q, want Foo", targetTitle)
	}
	if excerpt == "" {
		t.Error("excerpt: got empty, want non-empty")
	}
}

// TestSyncBacklinks_PendingTarget — source links to non-existent target (F2).
func TestSyncBacklinks_PendingTarget(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	sourceID := newNoteID(t, idx, "notes/source.md", 1700000001)

	reg := &notes.Registry{}
	reg.Hydrate(nil)

	refs := []markdown.WikiLinkRef{{Target: "Missing"}}
	content := []byte("Link to [[Missing]] here.\n")

	if err := idx.SyncBacklinks(ctx, sourceID, "notes/source.md", refs, reg, content); err != nil {
		t.Fatalf("SyncBacklinks: %v", err)
	}

	var targetIDIsNull bool
	var targetTitle string
	if err := idx.Pair.Reader.QueryRowContext(
		ctx,
		`SELECT target_id IS NULL, target_title FROM backlinks WHERE source_id = ?`,
		sourceID.String(),
	).Scan(&targetIDIsNull, &targetTitle); err != nil {
		t.Fatalf("query backlinks: %v", err)
	}
	if !targetIDIsNull {
		t.Error("pending link: expected target_id IS NULL")
	}
	if targetTitle != "Missing" {
		t.Errorf("target_title: got %q, want Missing", targetTitle)
	}
}

// TestSyncBacklinks_MultipleOccurrencesCollapse — [[Foo]] three times →
// ONE row (unique collapse) (F3).
func TestSyncBacklinks_MultipleOccurrencesCollapse(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	sourceID := newNoteID(t, idx, "notes/source.md", 1700000001)
	fooID := newNoteID(t, idx, "notes/foo.md", 1700000002)

	reg := &notes.Registry{}
	reg.Hydrate([]notes.NoteSummary{{ID: fooID, Path: "notes/foo.md", Title: "foo"}})

	refs := []markdown.WikiLinkRef{
		{Target: "Foo"},
		{Target: "Foo"},
		{Target: "Foo"},
	}
	content := []byte("[[Foo]] again [[Foo]] and [[Foo]].\n")

	if err := idx.SyncBacklinks(ctx, sourceID, "notes/source.md", refs, reg, content); err != nil {
		t.Fatalf("SyncBacklinks: %v", err)
	}

	var cnt int
	if err := idx.Pair.Reader.QueryRowContext(
		ctx,
		`SELECT COUNT(*) FROM backlinks WHERE source_id = ?`, sourceID.String(),
	).Scan(&cnt); err != nil {
		t.Fatalf("count: %v", err)
	}
	if cnt != 1 {
		t.Errorf("got %d rows, want 1 (dedup)", cnt)
	}
}

// TestSyncBacklinks_Replacement — previous refs [A,B] replaced by [B,C] (F4).
func TestSyncBacklinks_Replacement(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	sourceID := newNoteID(t, idx, "notes/source.md", 1700000001)

	reg := &notes.Registry{}
	reg.Hydrate(nil)

	refs1 := []markdown.WikiLinkRef{{Target: "A"}, {Target: "B"}}
	content1 := []byte("[[A]] and [[B]]\n")
	if err := idx.SyncBacklinks(ctx, sourceID, "notes/source.md", refs1, reg, content1); err != nil {
		t.Fatal(err)
	}

	refs2 := []markdown.WikiLinkRef{{Target: "B"}, {Target: "C"}}
	content2 := []byte("[[B]] and [[C]]\n")
	if err := idx.SyncBacklinks(ctx, sourceID, "notes/source.md", refs2, reg, content2); err != nil {
		t.Fatal(err)
	}

	rows, err := idx.Pair.Reader.QueryContext(ctx,
		`SELECT target_title FROM backlinks WHERE source_id = ? ORDER BY target_title`,
		sourceID.String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var titles []string
	for rows.Next() {
		var title string
		if err := rows.Scan(&title); err != nil {
			t.Fatal(err)
		}
		titles = append(titles, title)
	}
	if len(titles) != 2 {
		t.Fatalf("after replacement: got %d rows, want 2; titles=%v", len(titles), titles)
	}
	if titles[0] != "B" || titles[1] != "C" {
		t.Errorf("titles: got %v, want [B C]", titles)
	}
}

// TestSyncBacklinks_EmptyRefs — empty refs clears all backlinks (F5).
func TestSyncBacklinks_EmptyRefs(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	sourceID := newNoteID(t, idx, "notes/source.md", 1700000001)
	reg := &notes.Registry{}
	reg.Hydrate(nil)

	if err := idx.SyncBacklinks(ctx, sourceID, "notes/source.md",
		[]markdown.WikiLinkRef{{Target: "X"}}, reg, []byte("[[X]]\n")); err != nil {
		t.Fatal(err)
	}

	if err := idx.SyncBacklinks(ctx, sourceID, "notes/source.md", nil, reg, nil); err != nil {
		t.Fatal(err)
	}

	var cnt int
	if err := idx.Pair.Reader.QueryRowContext(
		ctx,
		`SELECT COUNT(*) FROM backlinks WHERE source_id = ?`, sourceID.String(),
	).Scan(&cnt); err != nil {
		t.Fatal(err)
	}
	if cnt != 0 {
		t.Errorf("empty sync: got %d rows, want 0", cnt)
	}
}

// TestSyncBacklinks_AmbiguousResolution — two notes titled "Foo", one in
// same folder as source → same-folder match is target_id (F6).
func TestSyncBacklinks_AmbiguousResolution(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	sourceID := newNoteID(t, idx, "notes/b/source.md", 1700000001)
	fooA := newNoteID(t, idx, "notes/a/foo.md", 1700000002)
	fooB := newNoteID(t, idx, "notes/b/foo.md", 1700000003)

	reg := &notes.Registry{}
	reg.Hydrate([]notes.NoteSummary{
		{ID: fooA, Path: "notes/a/foo.md", Title: "foo"},
		{ID: fooB, Path: "notes/b/foo.md", Title: "foo"},
	})

	refs := []markdown.WikiLinkRef{{Target: "Foo"}}
	content := []byte("See [[Foo]].\n")

	if err := idx.SyncBacklinks(ctx, sourceID, "notes/b/source.md", refs, reg, content); err != nil {
		t.Fatal(err)
	}

	var resolvedID string
	if err := idx.Pair.Reader.QueryRowContext(
		ctx,
		`SELECT COALESCE(target_id, '') FROM backlinks WHERE source_id = ?`,
		sourceID.String(),
	).Scan(&resolvedID); err != nil {
		t.Fatal(err)
	}
	if resolvedID != fooB.String() {
		t.Errorf("ambiguous resolution: got target_id %q, want same-folder fooB %q", resolvedID, fooB.String())
	}
}

// TestSyncBacklinks_ExcerptHTML — excerpt matches UI-SPEC contract (F7).
func TestSyncBacklinks_ExcerptHTML(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	sourceID := newNoteID(t, idx, "notes/source.md", 1700000001)
	reg := &notes.Registry{}
	reg.Hydrate(nil)

	refs := []markdown.WikiLinkRef{{Target: "Foo"}}
	content := []byte("prefix [[Foo]] suffix\nother line\n")

	if err := idx.SyncBacklinks(ctx, sourceID, "notes/source.md", refs, reg, content); err != nil {
		t.Fatal(err)
	}

	var excerpt string
	if err := idx.Pair.Reader.QueryRowContext(
		ctx,
		`SELECT excerpt FROM backlinks WHERE source_id = ?`, sourceID.String(),
	).Scan(&excerpt); err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(excerpt, `class="backlink-ref"`) {
		t.Errorf("excerpt missing backlink-ref class: %q", excerpt)
	}

	if !strings.Contains(excerpt, "[[Foo]]") {
		t.Errorf("excerpt missing [[Foo]]: %q", excerpt)
	}

	if !strings.Contains(excerpt, "<span>") {
		t.Errorf("excerpt missing <span> wrapper: %q", excerpt)
	}

	content2 := []byte(`<script>alert("xss")</script> [[Foo]] </script>` + "\n")
	if err := idx.SyncBacklinks(ctx, sourceID, "notes/source.md", refs, reg, content2); err != nil {
		t.Fatal(err)
	}
	var excerpt2 string
	if err := idx.Pair.Reader.QueryRowContext(
		ctx,
		`SELECT excerpt FROM backlinks WHERE source_id = ?`, sourceID.String(),
	).Scan(&excerpt2); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(excerpt2, "<script>") {
		t.Errorf("XSS not escaped in excerpt: %q", excerpt2)
	}
}

// TestGetBacklinks_Empty — 0 backlinks returns non-nil empty slice (G1).
func TestGetBacklinks_Empty(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	targetID := newNoteID(t, idx, "notes/target.md", 1700000001)

	rows, err := idx.GetBacklinks(context.Background(), targetID)
	if err != nil {
		t.Fatalf("GetBacklinks: %v", err)
	}
	if rows == nil {
		t.Fatal("GetBacklinks: got nil, want empty slice")
	}
	if len(rows) != 0 {
		t.Errorf("GetBacklinks: got %d, want 0", len(rows))
	}
}

// TestGetBacklinks_ReturnsRowsSortedByRecency — 3 sources link to target;
// sorted by source mtime desc (G2).
func TestGetBacklinks_ReturnsRowsSortedByRecency(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	targetID := newNoteID(t, idx, "notes/target.md", 1700000010)
	src1 := newNoteID(t, idx, "notes/src1.md", 1700000001)
	src2 := newNoteID(t, idx, "notes/src2.md", 1700000003)
	src3 := newNoteID(t, idx, "notes/src3.md", 1700000002)

	reg := &notes.Registry{}
	reg.Hydrate([]notes.NoteSummary{
		{ID: targetID, Path: "notes/target.md", Title: "target"},
	})

	for _, src := range []uuid.UUID{src1, src2, src3} {
		refs := []markdown.WikiLinkRef{{Target: "target"}}
		content := []byte("See [[target]] here.\n")
		if err := idx.SyncBacklinks(ctx, src, "notes/src.md", refs, reg, content); err != nil {
			t.Fatal(err)
		}
	}

	rows, err := idx.GetBacklinks(ctx, targetID)
	if err != nil {
		t.Fatalf("GetBacklinks: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("GetBacklinks: got %d, want 3", len(rows))
	}

	wantOrder := []uuid.UUID{src2, src3, src1}
	for i, w := range wantOrder {
		if rows[i].SourceID != w {
			t.Errorf("rows[%d].SourceID: got %v, want %v", i, rows[i].SourceID, w)
		}
	}
}

// TestGetBacklinks_PendingExcluded — pending backlinks (target_id IS NULL)
// are NOT returned by GetBacklinks for the target (G3).
func TestGetBacklinks_PendingExcluded(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	targetID := newNoteID(t, idx, "notes/target.md", 1700000010)
	sourceID := newNoteID(t, idx, "notes/source.md", 1700000001)

	reg := &notes.Registry{}
	reg.Hydrate(nil)

	refs := []markdown.WikiLinkRef{{Target: "target"}}
	content := []byte("See [[target]] here.\n")
	if err := idx.SyncBacklinks(ctx, sourceID, "notes/source.md", refs, reg, content); err != nil {
		t.Fatal(err)
	}

	rows, err := idx.GetBacklinks(ctx, targetID)
	if err != nil {
		t.Fatalf("GetBacklinks: %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("pending row returned by GetBacklinks — got %d rows, want 0", len(rows))
	}
}

// TestReconcileBacklinks_FullReindex — full reindex populates backlinks
// from wiki-links in .md files (H1).
func TestReconcileBacklinks_FullReindex(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTagTestIndexer(t)
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "foo.md", "# Foo\nThis is Foo.\n", mtime)
	writeNote(t, notesDir, "source.md",
		"---\ntags: []\n---\n\n# Source\n\nSee [[Foo]] here.\n", mtime)

	if _, err := idx.ReconcileWithRegistry(context.Background(), ModeFull, nil); err != nil {
		t.Fatalf("ReconcileWithRegistry: %v", err)
	}

	ctx := context.Background()
	var cnt int
	if err := idx.Pair.Reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM backlinks`).Scan(&cnt); err != nil {
		t.Fatal(err)
	}
	if cnt != 1 {
		t.Errorf("backlinks count after full reindex: got %d, want 1", cnt)
	}
}

// TestReconcileBacklinks_IncrementalSingleFile — incremental reconcile updates
// backlinks for changed file (H2).
func TestReconcileBacklinks_IncrementalSingleFile(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTagTestIndexer(t)
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}

	mtime1 := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "source.md", "# Source\nNo links.\n", mtime1)

	if _, err := idx.ReconcileWithRegistry(context.Background(), ModeFull, nil); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	var cnt int
	if err := idx.Pair.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM backlinks`).Scan(&cnt); err != nil {
		t.Fatal(err)
	}
	if cnt != 0 {
		t.Errorf("initial backlinks: got %d, want 0", cnt)
	}

	mtime2 := time.Unix(1700001000, 0)
	writeNote(t, notesDir, "source.md",
		"# Source\n\nSee [[Target]].\n", mtime2)

	if _, err := idx.ReconcileWithRegistry(ctx, ModeIncremental, nil); err != nil {
		t.Fatal(err)
	}

	if err := idx.Pair.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM backlinks`).Scan(&cnt); err != nil {
		t.Fatal(err)
	}
	if cnt != 1 {
		t.Errorf("after incremental update: got %d backlinks, want 1", cnt)
	}
}

// TestReconcileBacklinks_TAGS05_WipeAndRebuildBacklinks — wiping DB and
// rerunning ReconcileWithRegistry restores backlinks (H3).
func TestReconcileBacklinks_TAGS05_WipeAndRebuildBacklinks(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTagTestIndexer(t)
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "source.md",
		"---\ntags: [work]\n---\n\n# Source\n\n[[Foo]].\n", mtime)
	writeNote(t, notesDir, "foo.md", "# Foo\n", mtime)

	if _, err := idx.ReconcileWithRegistry(context.Background(), ModeFull, nil); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	var blCnt, tagCnt int
	if err := idx.Pair.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM backlinks`).Scan(&blCnt); err != nil {
		t.Fatal(err)
	}
	if err := idx.Pair.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM tags`).Scan(&tagCnt); err != nil {
		t.Fatal(err)
	}

	for _, tbl := range []string{"backlinks", "note_tags", "tags", "notes"} {
		if _, err := idx.Pair.Writer.ExecContext(ctx, `DELETE FROM `+tbl); err != nil {
			t.Fatalf("wipe %s: %v", tbl, err)
		}
	}

	if _, err := idx.ReconcileWithRegistry(ctx, ModeFull, nil); err != nil {
		t.Fatal(err)
	}

	var blCnt2, tagCnt2 int
	if err := idx.Pair.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM backlinks`).Scan(&blCnt2); err != nil {
		t.Fatal(err)
	}
	if err := idx.Pair.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM tags`).Scan(&tagCnt2); err != nil {
		t.Fatal(err)
	}

	if blCnt2 != blCnt {
		t.Errorf("backlinks count: before=%d after=%d", blCnt, blCnt2)
	}
	if tagCnt2 != tagCnt {
		t.Errorf("tags count: before=%d after=%d", tagCnt, tagCnt2)
	}
}

// TestBuildExcerpt_BasicContract verifies the UI-SPEC HTML contract.
func TestBuildExcerpt_BasicContract(t *testing.T) {
	t.Parallel()
	content := []byte("prefix [[Foo]] suffix\n")
	got := buildExcerpt(content, "Foo")

	if !strings.Contains(got, `class="backlink-ref"`) {
		t.Errorf("missing backlink-ref class: %q", got)
	}
	if !strings.Contains(got, "[[Foo]]") {
		t.Errorf("missing [[Foo]]: %q", got)
	}
	if !strings.Contains(got, "<span>prefix </span>") {
		t.Errorf("missing prefix span: %q", got)
	}
	if !strings.Contains(got, "<span> suffix</span>") {
		t.Errorf("missing suffix span: %q", got)
	}
}

// TestBuildExcerpt_XSSEscaping verifies that HTML in prefix/suffix is escaped.
func TestBuildExcerpt_XSSEscaping(t *testing.T) {
	t.Parallel()
	content := []byte(`<script>evil</script> [[Foo]] </script>` + "\n")
	got := buildExcerpt(content, "Foo")

	if strings.Contains(got, "<script>") {
		t.Errorf("XSS not escaped: %q", got)
	}
	if !strings.Contains(got, "&lt;script&gt;") {
		t.Errorf("expected HTML-escaped script tag: %q", got)
	}
}

// TestBuildExcerpt_NoMatch verifies empty string when target not found.
func TestBuildExcerpt_NoMatch(t *testing.T) {
	t.Parallel()
	content := []byte("No links here.\n")
	got := buildExcerpt(content, "Foo")
	if got != "" {
		t.Errorf("expected empty, got %q", got)
	}
}

// TestBuildExcerpt_CaseInsensitive verifies case-insensitive matching.
func TestBuildExcerpt_CaseInsensitive(t *testing.T) {
	t.Parallel()
	content := []byte("See [[FOO]] here.\n")
	got := buildExcerpt(content, "foo")
	if !strings.Contains(got, "backlink-ref") {
		t.Errorf("case-insensitive match failed: %q", got)
	}
}

// TestSyncBacklinks_ResolvesAfterHydrateFromIndex — regression for DI-02:
// exercises the hydrate-FROM-index path (Hydrate([]NoteSummary) fed by
// idx.List, the exact call the composition root makes at startup /
// hot-swap / after admin reindex), NOT in-session AddRecord. A fresh
// registry hydrated this way must still resolve wiki-links against notes
// indexed before this process started.
func TestSyncBacklinks_ResolvesAfterHydrateFromIndex(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	targetID := uuid.New()
	if err := idx.Upsert(ctx, notes.NoteRecord{
		ID: targetID, Path: "notes/target.md", Title: "Target", MTimeUnix: 1700000002,
	}); err != nil {
		t.Fatalf("seed target: %v", err)
	}
	sourceID := uuid.New()
	if err := idx.Upsert(ctx, notes.NoteRecord{
		ID: sourceID, Path: "notes/source.md", Title: "Source", MTimeUnix: 1700000001,
	}); err != nil {
		t.Fatalf("seed source: %v", err)
	}

	summaries, err := idx.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	reg := &notes.Registry{}
	reg.Hydrate(summaries)

	refs := []markdown.WikiLinkRef{{Target: "Target"}}
	content := []byte("Linking [[Target]] here.\n")
	if err := idx.SyncBacklinks(ctx, sourceID, "notes/source.md", refs, reg, content); err != nil {
		t.Fatalf("SyncBacklinks: %v", err)
	}

	rows, err := idx.GetBacklinks(ctx, targetID)
	if err != nil {
		t.Fatalf("GetBacklinks: %v", err)
	}
	if len(rows) == 0 {
		t.Fatalf("GetBacklinks after hydrate-from-index: got 0 rows, want non-empty (backlink dropped as pending)")
	}
}

// TestResolvePendingBacklinks_ResolvesAfterHydrateFromIndex — regression
// for DI-02: a pending row (seeded before any registry existed, mirroring
// TestResolvePendingBacklinks_Basic) must resolve once a registry is
// hydrated FROM the index via Hydrate([]NoteSummary) fed by idx.List —
// the real startup/rebuild path.
func TestResolvePendingBacklinks_ResolvesAfterHydrateFromIndex(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	targetID := uuid.New()
	if err := idx.Upsert(ctx, notes.NoteRecord{
		ID: targetID, Path: "notes/target.md", Title: "Target", MTimeUnix: 1700000002,
	}); err != nil {
		t.Fatalf("seed target: %v", err)
	}
	sourceID := uuid.New()
	if err := idx.Upsert(ctx, notes.NoteRecord{
		ID: sourceID, Path: "notes/source.md", Title: "Source", MTimeUnix: 1700000001,
	}); err != nil {
		t.Fatalf("seed source: %v", err)
	}

	refs := []markdown.WikiLinkRef{{Target: "Target"}}
	content := []byte("Linking [[Target]] here.\n")
	if err := idx.SyncBacklinks(ctx, sourceID, "notes/source.md", refs, nil, content); err != nil {
		t.Fatalf("SyncBacklinks with nil registry: %v", err)
	}

	var isNull bool
	if err := idx.Pair.Reader.QueryRowContext(
		ctx,
		`SELECT target_id IS NULL FROM backlinks WHERE source_id = ?`,
		sourceID.String(),
	).Scan(&isNull); err != nil {
		t.Fatalf("query pending row: %v", err)
	}
	if !isNull {
		t.Fatal("pre-condition failed: expected target_id IS NULL after nil-registry SyncBacklinks")
	}

	summaries, err := idx.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	reg := &notes.Registry{}
	reg.Hydrate(summaries)

	if err := idx.ResolvePendingBacklinks(ctx, reg); err != nil {
		t.Fatalf("ResolvePendingBacklinks: %v", err)
	}

	var gotTargetID string
	if err := idx.Pair.Reader.QueryRowContext(
		ctx,
		`SELECT COALESCE(target_id, '') FROM backlinks WHERE source_id = ?`,
		sourceID.String(),
	).Scan(&gotTargetID); err != nil {
		t.Fatalf("query resolved row: %v", err)
	}
	if gotTargetID != targetID.String() {
		t.Errorf("target_id after hydrate-from-index resolve: got %q, want %q", gotTargetID, targetID.String())
	}
}

// TestResolvePendingBacklinks_Basic — after a startup reconcile with nil
// registry leaves backlinks as pending (target_id = NULL),
// ResolvePendingBacklinks resolves them using the now-populated registry.
func TestResolvePendingBacklinks_Basic(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	sourceID := newNoteID(t, idx, "notes/a.md", 1700000001)
	targetID := newNoteID(t, idx, "notes/b.md", 1700000002)

	refs := []markdown.WikiLinkRef{{Target: "Note B"}}
	content := []byte("# Note A\nThis note links to [[Note B]].\n")
	if err := idx.SyncBacklinks(ctx, sourceID, "notes/a.md", refs, nil, content); err != nil {
		t.Fatalf("SyncBacklinks with nil registry: %v", err)
	}

	var isNull bool
	if err := idx.Pair.Reader.QueryRowContext(
		ctx,
		`SELECT target_id IS NULL FROM backlinks WHERE source_id = ?`,
		sourceID.String(),
	).Scan(&isNull); err != nil {
		t.Fatalf("query pending row: %v", err)
	}
	if !isNull {
		t.Fatal("pre-condition failed: expected target_id IS NULL after nil-registry SyncBacklinks")
	}

	reg := &notes.Registry{}
	reg.Hydrate([]notes.NoteSummary{
		{ID: targetID, Path: "notes/b.md", Title: "Note B"},
	})

	if err := idx.ResolvePendingBacklinks(ctx, reg); err != nil {
		t.Fatalf("ResolvePendingBacklinks: %v", err)
	}

	var gotTargetID string
	if err := idx.Pair.Reader.QueryRowContext(
		ctx,
		`SELECT COALESCE(target_id, '') FROM backlinks WHERE source_id = ?`,
		sourceID.String(),
	).Scan(&gotTargetID); err != nil {
		t.Fatalf("query resolved row: %v", err)
	}
	if gotTargetID != targetID.String() {
		t.Errorf("target_id: got %q, want %q", gotTargetID, targetID.String())
	}

	rows, err := idx.GetBacklinks(ctx, targetID)
	if err != nil {
		t.Fatalf("GetBacklinks: %v", err)
	}
	if len(rows) != 1 {
		t.Errorf("GetBacklinks: got %d rows, want 1", len(rows))
	}
}

// TestResolvePendingBacklinks_NilRegistry — no-op when registry is nil.
func TestResolvePendingBacklinks_NilRegistry(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	sourceID := newNoteID(t, idx, "notes/a.md", 1700000001)
	refs := []markdown.WikiLinkRef{{Target: "Ghost"}}
	content := []byte("Link to [[Ghost]].\n")
	if err := idx.SyncBacklinks(ctx, sourceID, "notes/a.md", refs, nil, content); err != nil {
		t.Fatalf("SyncBacklinks: %v", err)
	}

	if err := idx.ResolvePendingBacklinks(ctx, nil); err != nil {
		t.Fatalf("ResolvePendingBacklinks(nil): %v", err)
	}

	var isNull bool
	if err := idx.Pair.Reader.QueryRowContext(
		ctx,
		`SELECT target_id IS NULL FROM backlinks WHERE source_id = ?`,
		sourceID.String(),
	).Scan(&isNull); err != nil {
		t.Fatal(err)
	}
	if !isNull {
		t.Error("nil registry should leave row as pending")
	}
}

// TestResolvePendingBacklinks_UnresolvableStaysPending — when registry has
// no match for a pending title, the row stays pending (not an error).
func TestResolvePendingBacklinks_UnresolvableStaysPending(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	sourceID := newNoteID(t, idx, "notes/a.md", 1700000001)
	refs := []markdown.WikiLinkRef{{Target: "Nonexistent Note"}}
	content := []byte("Link to [[Nonexistent Note]].\n")
	if err := idx.SyncBacklinks(ctx, sourceID, "notes/a.md", refs, nil, content); err != nil {
		t.Fatalf("SyncBacklinks: %v", err)
	}

	reg := &notes.Registry{}
	reg.Hydrate([]notes.NoteSummary{
		{ID: uuid.New(), Path: "notes/other.md", Title: "Other Note"},
	})

	if err := idx.ResolvePendingBacklinks(ctx, reg); err != nil {
		t.Fatalf("ResolvePendingBacklinks: %v", err)
	}

	var isNull bool
	if err := idx.Pair.Reader.QueryRowContext(
		ctx,
		`SELECT target_id IS NULL FROM backlinks WHERE source_id = ?`,
		sourceID.String(),
	).Scan(&isNull); err != nil {
		t.Fatal(err)
	}
	if !isNull {
		t.Error("unresolvable title should remain pending")
	}
}

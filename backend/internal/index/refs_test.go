package index

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

func refTargets(t *testing.T, idx *Indexer, source notes.ID) []string {
	t.Helper()
	rows, err := idx.Pair.Reader.QueryContext(context.Background(),
		`SELECT target_ref, display, position, embed FROM refs WHERE source_id = ? ORDER BY id`, source.String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var target, display string
		var position, embed int
		if err := rows.Scan(&target, &display, &position, &embed); err != nil {
			t.Fatal(err)
		}
		s := target
		if display != "" {
			s += "|" + display
		}
		if embed != 0 {
			s = "!" + s
		}
		if position < 0 {
			s += "@fm"
		}
		out = append(out, s)
	}
	return out
}

func syncContent(t *testing.T, idx *Indexer, src notes.ID, path string, reg *notes.Registry, content string) notes.RefsDelta {
	t.Helper()
	delta, err := idx.SyncBacklinks(context.Background(), src, path, markdown.ExtractRefs([]byte(content)), reg, []byte(content))
	if err != nil {
		t.Fatalf("SyncBacklinks: %v", err)
	}
	return delta
}

// Criteria 5, 6 and 7: a foreign ref gets a refs row and answers backlinks,
// a title link resolves to the note's ref without the file changing, and
// removing a link removes the row and reports it.
func TestSyncBacklinks_RefsRows(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)
	ctx := context.Background()
	src := upsertTitled(t, idx, "notes/source.md", "Source")
	target := upsertTitled(t, idx, "notes/target.md", "Target")
	reg := notes.NewRegistry()
	reg.AddRecord(target, "notes/target.md", "target")

	content := "---\nrefs: [bt:task/7]\n---\nSee [[ado:workitem/12345|the ticket]] and [[Target]] and [[Nowhere]].\n![[jasper:blob/sha256-0123456789abcdef|shot.png]]\n"
	delta := syncContent(t, idx, src, "notes/source.md", reg, content)

	want := []string{"bt:task/7@fm", "ado:workitem/12345|the ticket", notes.RefForNote(target), "jasper:title/Nowhere", "!jasper:blob/sha256-0123456789abcdef|shot.png"}
	if got := refTargets(t, idx, src); !reflect.DeepEqual(got, want) {
		t.Errorf("refs rows = %v, want %v", got, want)
	}
	wantAdded := []string{"ado:workitem/12345", "bt:task/7", "jasper:blob/sha256-0123456789abcdef", notes.RefForNote(target), "jasper:title/Nowhere"}
	if !reflect.DeepEqual(delta.Added, wantAdded) || len(delta.Removed) != 0 {
		t.Errorf("delta = %+v, want added %v", delta, wantAdded)
	}

	// The foreign ref is a backlink, never a pending title.
	bl, err := idx.RefBacklinks(ctx, "ado:workitem/12345")
	if err != nil || len(bl) != 1 || bl[0].SourceID != src || bl[0].Display != "the ticket" || bl[0].SourceTitle != "Source" {
		t.Errorf("RefBacklinks = %+v, %v", bl, err)
	}
	var pending int
	_ = idx.Pair.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM backlinks WHERE target_title LIKE 'ado:%'`).Scan(&pending)
	if pending != 0 {
		t.Errorf("foreign ref became a pending backlink")
	}
	// Title links answer by the note's ref, so a renamed note keeps its backlinks.
	if bl, _ := idx.RefBacklinks(ctx, notes.RefForNote(target)); len(bl) != 1 {
		t.Errorf("note ref backlinks = %+v", bl)
	}
	if bl, _ := idx.RefBacklinks(ctx, "nothing:here/1"); bl == nil || len(bl) != 0 {
		t.Errorf("unknown target = %+v, want empty non-nil", bl)
	}

	delta = syncContent(t, idx, src, "notes/source.md", reg, "See [[Target]] only.\n")
	if got := refTargets(t, idx, src); !reflect.DeepEqual(got, []string{notes.RefForNote(target)}) {
		t.Errorf("refs after removal = %v", got)
	}
	wantRemoved := []string{"ado:workitem/12345", "bt:task/7", "jasper:blob/sha256-0123456789abcdef", "jasper:title/Nowhere"}
	if !reflect.DeepEqual(delta.Removed, wantRemoved) || len(delta.Added) != 0 {
		t.Errorf("delta after removal = %+v", delta)
	}
	if bl, _ := idx.RefBacklinks(ctx, "ado:workitem/12345"); len(bl) != 0 {
		t.Errorf("removed ref still answers backlinks: %+v", bl)
	}
}

func TestResolvePendingBacklinks_UpdatesRefs(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)
	ctx := context.Background()
	src := upsertTitled(t, idx, "notes/source.md", "Source")
	target := upsertTitled(t, idx, "notes/target.md", "Target")
	syncContent(t, idx, src, "notes/source.md", nil, "[[Target]]")
	if got := refTargets(t, idx, src); !reflect.DeepEqual(got, []string{"jasper:title/Target"}) {
		t.Fatalf("pending ref = %v", got)
	}

	reg := notes.NewRegistry()
	reg.AddRecord(target, "notes/target.md", "target")
	if err := idx.ResolvePendingBacklinks(ctx, reg); err != nil {
		t.Fatal(err)
	}
	if got := refTargets(t, idx, src); !reflect.DeepEqual(got, []string{notes.RefForNote(target)}) {
		t.Errorf("resolved ref = %v", got)
	}

	if err := idx.UpdateBacklinksTargetTitle(ctx, "Target", "Renamed", nil); err != nil {
		t.Fatal(err)
	}
	syncContent(t, idx, src, "notes/source.md", nil, "[[Ghost]]")
	if err := idx.UpdateBacklinksTargetTitle(ctx, "Ghost", "Spirit", nil); err != nil {
		t.Fatal(err)
	}
	if got := refTargets(t, idx, src); !reflect.DeepEqual(got, []string{"jasper:title/Spirit"}) {
		t.Errorf("renamed pending ref = %v", got)
	}
}

func TestLookupItem(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	ctx := context.Background()
	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "a.md", "---\ntags: []\n---\n# Alpha\n\nThe body starts here and goes on.\n", mtime)
	writeAttachment(t, notesDir, "attachments/pic.png", []byte("v1"), mtime)
	if _, err := idx.Reconcile(ctx, ModeFull); err != nil {
		t.Fatal(err)
	}
	noteID := fileID(t, notesDir, "a.md")
	blob := blobAt(t, idx, "attachments/pic.png")

	for _, id := range []string{noteID.String(), notes.RefForNote(noteID)} {
		info, err := idx.LookupItem(ctx, id)
		if err != nil || info.Status != notes.ItemStatusOK || info.Kind != notes.ItemKindNote || info.Title != "Alpha" || info.Path != "a.md" || info.ID != id {
			t.Errorf("LookupItem(%s) = %+v, %v", id, info, err)
		}
		if !strings.HasPrefix(info.Excerpt, "Alpha The body starts here") || info.UpdatedAt.Unix() != mtime.Unix() {
			t.Errorf("excerpt/updated = %q / %v", info.Excerpt, info.UpdatedAt)
		}
	}
	for _, id := range []string{blob.ID, notes.RefForBlob(blob.ID)} {
		info, err := idx.LookupItem(ctx, id)
		if err != nil || info.Status != notes.ItemStatusOK || info.Kind != notes.ItemKindBlob || info.Title != "pic.png" || info.Path != "attachments/pic.png" {
			t.Errorf("LookupItem(%s) = %+v, %v", id, info, err)
		}
	}
	if info, _ := idx.LookupItem(ctx, notes.RefForNote(notes.NewID())); info.Status != notes.ItemStatusUnknown || info.Kind != notes.ItemKindNote {
		t.Errorf("unknown note = %+v", info)
	}
	if info, _ := idx.LookupItem(ctx, "jasper:note/not-an-id"); info.Status != notes.ItemStatusUnknown {
		t.Errorf("malformed id = %+v", info)
	}

	// Gone: the note is deleted, the blob edited in place.
	if err := os.Remove(filepath.Join(notesDir, "a.md")); err != nil {
		t.Fatal(err)
	}
	writeAttachment(t, notesDir, "attachments/pic.png", []byte("v2!"), time.Unix(1700000100, 0))
	if _, err := idx.Reconcile(ctx, ModeIncremental); err != nil {
		t.Fatal(err)
	}
	info, _ := idx.LookupItem(ctx, notes.RefForNote(noteID))
	if info.Status != notes.ItemStatusDeleted || info.Title != "Alpha" || info.Path != "a.md" || info.UpdatedAt.IsZero() {
		t.Errorf("deleted note = %+v", info)
	}
	newBlob := blobAt(t, idx, "attachments/pic.png")
	info, _ = idx.LookupItem(ctx, notes.RefForBlob(blob.ID))
	if info.Status != notes.ItemStatusDeleted || info.Title != "pic.png" || info.ReplacedBy != newBlob.ID {
		t.Errorf("replaced blob = %+v", info)
	}
}

func TestExcerpt(t *testing.T) {
	t.Parallel()
	if got := excerpt("  two\n\nlines  here "); got != "two lines here" {
		t.Errorf("excerpt = %q", got)
	}
	long := strings.Repeat("é ", 150)
	if got := excerpt(long); len([]rune(got)) != excerptRunes+1 || !strings.HasSuffix(got, "…") {
		t.Errorf("long excerpt = %q (%d runes)", got, len([]rune(got)))
	}
}

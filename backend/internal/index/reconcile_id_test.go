package index

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

func readNote(t *testing.T, notesDir, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(notesDir, rel))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(b)
}

func rowsByPath(t *testing.T, idx *Indexer) map[string]notes.NoteSummary {
	t.Helper()
	list, err := idx.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	out := make(map[string]notes.NoteSummary, len(list))
	for _, s := range list {
		out[s.Path] = s
	}
	return out
}

func fileID(t *testing.T, notesDir, rel string) notes.ID {
	t.Helper()
	raw, found := markdown.ReadID([]byte(readNote(t, notesDir, rel)))
	if !found {
		t.Fatalf("%s carries no id", rel)
	}
	id, err := notes.ParseID(raw)
	if err != nil {
		t.Fatalf("%s carries a malformed id %q", rel, raw)
	}
	return id
}

// Criterion 1: a note without an id gets one, and nothing else changes.
func TestReconcile_WritesMissingID(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	writeNoteRaw(t, notesDir, "a.md", "# Alpha\n\nbody\n", time.Unix(1700000000, 0))

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	id := fileID(t, notesDir, "a.md")
	if got, want := readNote(t, notesDir, "a.md"), "---\nid: "+id.String()+"\n---\n# Alpha\n\nbody\n"; got != want {
		t.Errorf("file after reconcile\n got: %q\nwant: %q", got, want)
	}
	if rows := rowsByPath(t, idx); rows["a.md"].ID != id {
		t.Errorf("index id %s, file id %s", rows["a.md"].ID, id)
	}

	// The post-write mtime was indexed, so the next pass has nothing to do.
	before, _ := os.Stat(filepath.Join(notesDir, "a.md"))
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatalf("second Reconcile: %v", err)
	}
	after, _ := os.Stat(filepath.Join(notesDir, "a.md"))
	if !before.ModTime().Equal(after.ModTime()) {
		t.Errorf("incremental pass rewrote an already-identified note")
	}
}

// Criterion 3: a rebuild from notes/ restores the same ids.
func TestReconcile_RebuildRestoresIDs(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	mtime := time.Unix(1700000000, 0)
	writeNoteRaw(t, notesDir, "a.md", "# Alpha\n", mtime)
	writeNoteRaw(t, notesDir, "sub/b.md", "---\ntags: [x]\n---\n# Bravo\n", mtime)
	writeAttachment(t, notesDir, "attachments/shared.png", []byte("\x89PNG shared"), mtime)
	writeAttachment(t, notesDir, "sub/attachments/shared-copy.png", []byte("\x89PNG shared"), mtime)
	writeAttachment(t, notesDir, "attachments/solo.pdf", []byte("%PDF-1.4 solo"), mtime)
	blobPaths := []string{"attachments/shared.png", "sub/attachments/shared-copy.png", "attachments/solo.pdf"}
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	first := rowsByPath(t, idx)
	firstBlobs := map[string]string{}
	for _, p := range blobPaths {
		firstBlobs[p] = blobAt(t, idx, p).ID
	}
	if firstBlobs["attachments/shared.png"] == firstBlobs["attachments/solo.pdf"] {
		t.Fatalf("distinct bytes share blob id %s", firstBlobs["attachments/solo.pdf"])
	}

	fresh, _ := newTestIndexer(t)
	fresh.NotesDir = notesDir
	if _, err := fresh.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("rebuild Reconcile: %v", err)
	}
	second := rowsByPath(t, fresh)
	for path, row := range first {
		if second[path].ID != row.ID {
			t.Errorf("%s: id %s before rebuild, %s after", path, row.ID, second[path].ID)
		}
	}
	for _, p := range blobPaths {
		if got := blobAt(t, fresh, p).ID; got != firstBlobs[p] {
			t.Errorf("%s: blob id %s before rebuild, %s after", p, firstBlobs[p], got)
		}
	}
}

// Criterion 4: a copy of a note gets its own id; the original keeps its own.
func TestReconcile_CopyGetsDistinctID(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "a.md", "# Alpha\n", mtime)
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("seed Reconcile: %v", err)
	}
	original := readNote(t, notesDir, "a.md")
	originalID := fileID(t, notesDir, "a.md")

	// Finder's Duplicate: same bytes, same mtime.
	writeNoteRaw(t, notesDir, "a copy.md", original, mtime)
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	if got := readNote(t, notesDir, "a.md"); got != original {
		t.Errorf("original was rewritten: %q", got)
	}
	copyID := fileID(t, notesDir, "a copy.md")
	if copyID == originalID {
		t.Fatalf("copy kept the original's id %s", copyID)
	}
	rows := rowsByPath(t, idx)
	if rows["a.md"].ID != originalID || rows["a copy.md"].ID != copyID {
		t.Errorf("rows = %+v", rows)
	}
}

// With no prior index, two files claiming one id are settled by birthtime,
// then path; the loser is re-identified on disk.
func TestReconcile_FullRebuildSettlesDuplicate(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	mtime := time.Unix(1700000000, 0)
	content := "---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\n# Twin\n"
	writeNoteRaw(t, notesDir, "a.md", content, mtime)
	writeNoteRaw(t, notesDir, "b.md", content, mtime)

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	aID, bID := fileID(t, notesDir, "a.md"), fileID(t, notesDir, "b.md")
	if aID != "01ARZ3NDEKTSV4RRFFQ69G5FAV" {
		t.Errorf("a.md (earlier, lexically first) lost its id: %s", aID)
	}
	if bID == aID {
		t.Errorf("both files still carry %s", aID)
	}
	rows := rowsByPath(t, idx)
	if rows["a.md"].ID != aID || rows["b.md"].ID != bID {
		t.Errorf("rows = %+v", rows)
	}
}

// An id edited outside the app is the source of truth; the old id is retired.
func TestReconcile_ExternalIDEditWins(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	writeNote(t, notesDir, "a.md", "# Alpha\n", time.Unix(1700000000, 0))
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("seed Reconcile: %v", err)
	}
	oldID := fileID(t, notesDir, "a.md")

	newID := notes.NewID()
	writeNoteRaw(t, notesDir, "a.md", "---\nid: "+newID.String()+"\n---\n# Alpha\n", time.Unix(1700000100, 0))
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	rows := rowsByPath(t, idx)
	if len(rows) != 1 || rows["a.md"].ID != newID {
		t.Errorf("rows = %+v, want a.md under %s", rows, newID)
	}
	ts, ok, err := idx.GetTombstone(context.Background(), oldID.String())
	if err != nil || !ok {
		t.Fatalf("tombstone for %s: %v, %v", oldID, ok, err)
	}
	if ts.LastPath != "a.md" || ts.LastTitle != "Alpha" {
		t.Errorf("tombstone = %+v", ts)
	}
}

// Criterion 2, from outside the app: a rename keeps the id and is not a delete.
func TestReconcile_ExternalRenameKeepsID(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	writeNote(t, notesDir, "a.md", "# Alpha\n", time.Unix(1700000000, 0))
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("seed Reconcile: %v", err)
	}
	id := fileID(t, notesDir, "a.md")

	if err := os.Rename(filepath.Join(notesDir, "a.md"), filepath.Join(notesDir, "b.md")); err != nil {
		t.Fatal(err)
	}
	res, err := idx.Reconcile(context.Background(), ModeIncremental)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	rows := rowsByPath(t, idx)
	if n := res.N; n != 1 || rows["b.md"].ID != id {
		t.Errorf("n=%d rows=%+v, want b.md under %s", n, rows, id)
	}
	if _, ok, _ := idx.GetTombstone(context.Background(), id.String()); ok {
		t.Errorf("a moved note was tombstoned")
	}
}

// A vanished note is tombstoned with what it was; coming back clears it.
func TestReconcile_DeleteTombstonesAndRestoreClears(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	writeNote(t, notesDir, "sub/a.md", "# Alpha\n", time.Unix(1700000000, 0))
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("seed Reconcile: %v", err)
	}
	content := readNote(t, notesDir, "sub/a.md")
	id := fileID(t, notesDir, "sub/a.md")

	if err := os.Remove(filepath.Join(notesDir, "sub/a.md")); err != nil {
		t.Fatal(err)
	}
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatalf("Reconcile after delete: %v", err)
	}
	if rows := rowsByPath(t, idx); len(rows) != 0 {
		t.Errorf("rows after delete = %+v", rows)
	}
	ts, ok, err := idx.GetTombstone(context.Background(), id.String())
	if err != nil || !ok || ts.LastPath != "sub/a.md" || ts.LastTitle != "Alpha" || ts.DeletedAt == 0 {
		t.Fatalf("tombstone = %+v, %v, %v", ts, ok, err)
	}

	writeNoteRaw(t, notesDir, "sub/a.md", content, time.Unix(1700000200, 0))
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatalf("Reconcile after restore: %v", err)
	}
	if rows := rowsByPath(t, idx); rows["sub/a.md"].ID != id {
		t.Errorf("restored note did not keep %s: %+v", id, rows)
	}
	if _, ok, _ := idx.GetTombstone(context.Background(), id.String()); ok {
		t.Errorf("tombstone survived the restore")
	}
}

func TestReconcile_MalformedIDIsReplaced(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	writeNoteRaw(t, notesDir, "a.md", "---\nid: 00000000-0000-4000-a000-000000000009\ntags: []\n---\n# A\n", time.Unix(1700000000, 0))
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	id := fileID(t, notesDir, "a.md")
	if got, want := readNote(t, notesDir, "a.md"), "---\nid: "+id.String()+"\ntags: []\n---\n# A\n"; got != want {
		t.Errorf("file\n got: %q\nwant: %q", got, want)
	}
	if rows := rowsByPath(t, idx); rows["a.md"].ID != id {
		t.Errorf("rows = %+v", rows)
	}
}

// A CRLF note gets its id like any other; its frontmatter becomes LF.
func TestReconcile_CRLFNoteGetsID(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	writeNoteRaw(t, notesDir, "w.md", "---\r\ntags: []\r\n---\r\n# Windows\r\n", time.Unix(1700000000, 0))
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	id := rowsByPath(t, idx)["w.md"].ID
	if got, want := readNote(t, notesDir, "w.md"), "---\nid: "+id.String()+"\ntags: []\n---\n# Windows\r\n"; got != want {
		t.Errorf("file\n got: %q\nwant: %q", got, want)
	}
}

// A CRLF note that already carries an id keeps it.
func TestReconcile_CRLFNoteKeepsItsID(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
	content := "---\r\nid: " + id + "\r\ntags: []\r\n---\r\n# Windows\r\n"
	writeNoteRaw(t, notesDir, "w.md", content, time.Unix(1700000000, 0))
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if got := rowsByPath(t, idx)["w.md"].ID.String(); got != id {
		t.Errorf("indexed under %s, want %s", got, id)
	}
	if got := readNote(t, notesDir, "w.md"); got != content {
		t.Errorf("note was rewritten: %q", got)
	}
}

func TestAssignIDs_TieBreak(t *testing.T) {
	t.Parallel()
	const x = notes.ID("01ARZ3NDEKTSV4RRFFQ69G5FAV")
	mk := func(path string, birth int64, want notes.ID) *claim {
		return &claim{meta: FileMeta{CanonicalRelPath: path, BirthtimeUnix: birth}, fileID: want, wantID: want}
	}

	t.Run("the path already indexed under the id keeps it", func(t *testing.T) {
		older := mk("older.md", 100, x)
		indexed := mk("z-indexed.md", 200, x)
		existing := map[string]existingRow{"z-indexed.md": {ID: x}}
		assignIDs([]*claim{older, indexed}, existing, map[string]bool{"z-indexed.md": true, "older.md": true})
		if indexed.id != x || older.id == x || older.id == "" {
			t.Errorf("indexed=%s older=%s", indexed.id, older.id)
		}
	})
	t.Run("earlier birthtime wins, unknown birthtime loses", func(t *testing.T) {
		early, late, unknown := mk("c.md", 100, x), mk("a.md", 200, x), mk("b.md", 0, x)
		assignIDs([]*claim{late, unknown, early}, nil, nil)
		if early.id != x || late.id == x || unknown.id == x {
			t.Errorf("early=%s late=%s unknown=%s", early.id, late.id, unknown.id)
		}
	})
	t.Run("equal birthtimes fall back to the smaller path", func(t *testing.T) {
		a, b := mk("a.md", 100, x), mk("b.md", 100, x)
		assignIDs([]*claim{b, a}, nil, nil)
		if a.id != x || b.id == x || b.id == "" {
			t.Errorf("a=%s b=%s", a.id, b.id)
		}
	})
	t.Run("an id held by an unchanged row is not handed out", func(t *testing.T) {
		c := mk("new.md", 100, x)
		existing := map[string]existingRow{"held.md": {ID: x}}
		assignIDs([]*claim{c}, existing, map[string]bool{"held.md": true, "new.md": true})
		if c.id == x || c.id == "" {
			t.Errorf("new.md got %s", c.id)
		}
	})
	t.Run("a note without an id keeps the id its path was indexed under", func(t *testing.T) {
		c := &claim{meta: FileMeta{CanonicalRelPath: "a.md"}, wantID: x}
		assignIDs([]*claim{c}, map[string]existingRow{"a.md": {ID: x}}, map[string]bool{"a.md": true})
		if c.id != x {
			t.Errorf("a.md got %s", c.id)
		}
	})
	t.Run("the scratchpad gets its fixed id", func(t *testing.T) {
		c := &claim{meta: FileMeta{CanonicalRelPath: notes.ScratchpadRelPath}}
		assignIDs([]*claim{c}, nil, nil)
		if c.id != notes.ScratchpadID {
			t.Errorf("scratchpad got %s", c.id)
		}
	})
}

// A save that lands between the walk's read and the id write wins.
func TestReconcile_WriteIDKeepsConcurrentSave(t *testing.T) {
	t.Parallel()
	const savedID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
	cases := []struct {
		name  string
		saved string
		want  func(id notes.ID) string
	}{
		{
			name:  "save carries an id",
			saved: "---\nid: " + savedID + "\n---\n# Saved\n",
			want:  func(notes.ID) string { return "---\nid: " + savedID + "\n---\n# Saved\n" },
		},
		{
			name:  "save carries no id",
			saved: "# Saved\n\nnew body\n",
			want:  func(id notes.ID) string { return "---\nid: " + id.String() + "\n---\n# Saved\n\nnew body\n" },
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			idx, notesDir := newReconcileFixture(t)
			writeNoteRaw(t, notesDir, "a.md", "# Alpha\n", time.Unix(1700000000, 0))
			idx.afterWalk = func() {
				writeNoteRaw(t, notesDir, "a.md", tc.saved, time.Unix(1700000100, 0))
			}

			if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
				t.Fatalf("Reconcile: %v", err)
			}
			id := fileID(t, notesDir, "a.md")
			if got, want := readNote(t, notesDir, "a.md"), tc.want(id); got != want {
				t.Errorf("file after reconcile\n got: %q\nwant: %q", got, want)
			}
			row := rowsByPath(t, idx)["a.md"]
			if row.ID != id {
				t.Errorf("index id %s, file id %s", row.ID, id)
			}
			if row.Title != "Saved" {
				t.Errorf("indexed title %q, want the saved content's", row.Title)
			}
		})
	}
}

func TestReconcile_ReportsRefsDeltas(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	writeNoteRaw(t, notesDir, "plain.md", "# Plain\n", time.Unix(1700000000, 0))
	writeNoteRaw(t, notesDir, "linker.md", "# Linker\n\n[[ado:workitem/7]]\n", time.Unix(1700000000, 0))

	res, err := idx.Reconcile(context.Background(), ModeFull)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if len(res.Deltas) != 1 {
		t.Fatalf("deltas = %+v, want one for linker.md", res.Deltas)
	}
	d := res.Deltas[0]
	if d.ID != fileID(t, notesDir, "linker.md") || len(d.Delta.Added) != 1 || d.Delta.Added[0] != "ado:workitem/7" {
		t.Errorf("delta = %+v", d)
	}
}

// Concurrent passes would each settle ids against a stale snapshot of the
// index and redo every write; they run one at a time.
func TestReconcile_ConcurrentPassesDoNotOverlap(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	writeNoteRaw(t, notesDir, "a.md", "# Alpha\n", time.Unix(1700000000, 0))

	done := make(chan struct{})
	idx.afterWalk = func() {
		idx.afterWalk = nil
		go func() {
			defer close(done)
			if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
				t.Errorf("second Reconcile: %v", err)
			}
		}()
		select {
		case <-done:
			t.Error("a second reconcile ran to completion inside the first")
		case <-time.After(100 * time.Millisecond):
		}
	}
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	<-done
}

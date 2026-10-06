package index

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeAttachment(t *testing.T, notesDir, rel string, content []byte, mtime time.Time) {
	t.Helper()
	full := filepath.Join(notesDir, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, content, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(full, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

func digestOf(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func blobAt(t *testing.T, idx *Indexer, path string) Blob {
	t.Helper()
	b, ok, err := idx.BlobAtPath(context.Background(), path)
	if err != nil || !ok {
		t.Fatalf("BlobAtPath(%s) = %+v, %v, %v", path, b, ok, err)
	}
	return b
}

func TestReconcileBlobs_IndexesAttachmentsOnly(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	mtime := time.Unix(1700000000, 0)
	png := []byte("\x89PNG\r\n\x1a\nnot really")
	writeAttachment(t, notesDir, "attachments/shot.png", png, mtime)
	writeAttachment(t, notesDir, "proj/attachments/spec.pdf", []byte("%PDF-1.4 x"), mtime)
	writeAttachment(t, notesDir, "notes.txt", []byte("plain"), mtime)
	writeAttachment(t, notesDir, ".trash/gone.png", png, mtime)
	writeAttachment(t, notesDir, "attachments/.DS_Store", []byte("x"), mtime)
	writeNote(t, notesDir, "a.md", "# A\n", mtime)

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	shot := blobAt(t, idx, "attachments/shot.png")
	if shot.ID != "sha256-"+digestOf(png)[:16] || shot.SHA256 != digestOf(png) || shot.Size != int64(len(png)) || shot.Mime != "image/png" {
		t.Errorf("shot = %+v", shot)
	}
	if spec := blobAt(t, idx, "proj/attachments/spec.pdf"); spec.Mime != "application/pdf" {
		t.Errorf("spec = %+v", spec)
	}
	if txt := blobAt(t, idx, "notes.txt"); !strings.HasPrefix(txt.Mime, "text/plain") {
		t.Errorf("txt = %+v", txt)
	}
	for _, skipped := range []string{".trash/gone.png", "attachments/.ds_store", "a.md"} {
		if _, ok, _ := idx.BlobAtPath(context.Background(), skipped); ok {
			t.Errorf("%s was indexed as a blob", skipped)
		}
	}

	var kinds []string
	rows, err := idx.Pair.Reader.QueryContext(context.Background(), `SELECT kind || ':' || title FROM items ORDER BY kind, path`)
	if err != nil {
		t.Fatalf("items view: %v", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var k string
		_ = rows.Scan(&k)
		kinds = append(kinds, k)
	}
	if got, want := strings.Join(kinds, ","), "blob:shot.png,blob:notes.txt,blob:spec.pdf,note:A"; got != want {
		t.Errorf("items = %s, want %s", got, want)
	}
}

func TestReconcileBlobs_IdenticalBytesShareOneBlob(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	mtime := time.Unix(1700000000, 0)
	bytes := []byte("same bytes")
	writeAttachment(t, notesDir, "a/attachments/x.bin", bytes, mtime)
	writeAttachment(t, notesDir, "b/attachments/y.bin", bytes, mtime)
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	x := blobAt(t, idx, "a/attachments/x.bin")
	if got := strings.Join(x.Paths, ","); got != "a/attachments/x.bin,b/attachments/y.bin" {
		t.Errorf("paths = %s", got)
	}

	// Losing one path keeps the blob alive and writes no tombstone.
	if err := os.Remove(filepath.Join(notesDir, "a/attachments/x.bin")); err != nil {
		t.Fatal(err)
	}
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if y := blobAt(t, idx, "b/attachments/y.bin"); y.ID != x.ID || len(y.Paths) != 1 {
		t.Errorf("after removing one path: %+v", y)
	}
	if _, ok, _ := idx.GetTombstone(context.Background(), x.ID); ok {
		t.Errorf("a blob still held elsewhere was tombstoned")
	}
}

// Criterion 8: editing a file in place yields a new blob; the old one is
// tombstoned pointing at its replacement.
func TestReconcileBlobs_InPlaceEditReplaces(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	writeAttachment(t, notesDir, "attachments/pic.png", []byte("v1"), time.Unix(1700000000, 0))
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	old := blobAt(t, idx, "attachments/pic.png")

	writeAttachment(t, notesDir, "attachments/pic.png", []byte("v2 longer"), time.Unix(1700000100, 0))
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	cur := blobAt(t, idx, "attachments/pic.png")
	if cur.ID == old.ID || cur.SHA256 != digestOf([]byte("v2 longer")) {
		t.Errorf("edit did not produce a new blob: old %+v cur %+v", old, cur)
	}
	if _, ok, _ := idx.GetBlob(context.Background(), old.ID); ok {
		t.Errorf("old blob row survived with no paths")
	}
	ts, ok, err := idx.GetTombstone(context.Background(), old.ID)
	if err != nil || !ok {
		t.Fatalf("tombstone: %v %v", ok, err)
	}
	if ts.ReplacedBy != cur.ID || ts.LastPath != "attachments/pic.png" || ts.LastTitle != "pic.png" {
		t.Errorf("tombstone = %+v", ts)
	}
}

func TestReconcileBlobs_DeleteTombstonesAndRestoreClears(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	content := []byte("bytes")
	writeAttachment(t, notesDir, "attachments/f.bin", content, time.Unix(1700000000, 0))
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	b := blobAt(t, idx, "attachments/f.bin")

	if err := os.Remove(filepath.Join(notesDir, "attachments/f.bin")); err != nil {
		t.Fatal(err)
	}
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	ts, ok, _ := idx.GetTombstone(context.Background(), b.ID)
	if !ok || ts.ReplacedBy != "" || ts.LastPath != "attachments/f.bin" {
		t.Fatalf("tombstone = %+v, %v", ts, ok)
	}

	writeAttachment(t, notesDir, "elsewhere/attachments/f.bin", content, time.Unix(1700000200, 0))
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if back := blobAt(t, idx, "elsewhere/attachments/f.bin"); back.ID != b.ID {
		t.Errorf("restored bytes got a different id: %s vs %s", back.ID, b.ID)
	}
	if _, ok, _ := idx.GetTombstone(context.Background(), b.ID); ok {
		t.Errorf("tombstone survived the blob's return")
	}
}

// An unchanged (mtime, size) pair is trusted; a full pass trusts nothing.
func TestReconcileBlobs_SkipsUnchangedPairs(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	mtime := time.Unix(1700000000, 0)
	writeAttachment(t, notesDir, "attachments/f.bin", []byte("aaaa"), mtime)
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	first := blobAt(t, idx, "attachments/f.bin")

	// Same length, same mtime: invisible to the incremental pass.
	writeAttachment(t, notesDir, "attachments/f.bin", []byte("bbbb"), mtime)
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if got := blobAt(t, idx, "attachments/f.bin"); got.ID != first.ID {
		t.Errorf("incremental pass re-hashed an unchanged pair")
	}
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if got := blobAt(t, idx, "attachments/f.bin"); got.SHA256 != digestOf([]byte("bbbb")) {
		t.Errorf("full pass did not re-hash: %+v", got)
	}
}

func TestReconcileBlobs_PrefixCollisionExtendsBothIDs(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	content := []byte("new file")
	digest := digestOf(content)
	// Another digest already owns this file's 16-hex prefix.
	imposter := digest[:16] + strings.Repeat("f", 48)
	ctx := context.Background()
	if _, err := idx.Pair.Writer.ExecContext(ctx,
		`INSERT INTO blobs(id, sha256, mime, size, updated_at) VALUES (?, ?, 'x/y', 1, 1)`,
		"sha256-"+digest[:16], imposter); err != nil {
		t.Fatal(err)
	}
	if _, err := idx.Pair.Writer.ExecContext(ctx,
		`INSERT INTO blob_paths(path, blob_id, mtime_unix, size_bytes) VALUES ('old.bin', ?, 1, 1)`,
		"sha256-"+digest[:16]); err != nil {
		t.Fatal(err)
	}

	writeAttachment(t, notesDir, "attachments/new.bin", content, time.Unix(1700000000, 0))
	if _, err := idx.Reconcile(ctx, ModeIncremental); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if got := blobAt(t, idx, "attachments/new.bin"); got.ID != "sha256-"+digest {
		t.Errorf("new blob id = %s, want the full digest", got.ID)
	}
	// old.bin is not on disk, so it was retired; its blob row was re-keyed
	// first, which is what the tombstone records.
	if ts, ok, _ := idx.GetTombstone(ctx, "sha256-"+imposter); !ok || ts.LastPath != "old.bin" {
		t.Errorf("re-keyed blob tombstone = %+v, %v", ts, ok)
	}
	if _, ok, _ := idx.GetBlob(ctx, "sha256-"+digest[:16]); ok {
		t.Errorf("short id still exists")
	}
}

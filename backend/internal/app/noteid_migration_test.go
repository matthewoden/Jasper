package app

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

func hasNoteIDMarker(t *testing.T, db *sql.DB) bool {
	t.Helper()
	var dummy string
	err := db.QueryRowContext(context.Background(),
		`SELECT version FROM schema_migrations WHERE version = ?`, NoteIDMarker).Scan(&dummy)
	return err == nil
}

func snapshotDir(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		rel, _ := filepath.Rel(dir, path)
		out[filepath.ToSlash(rel)] = string(b)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// Criterion 15: the dry run writes nothing; the real run changes only id lines.
func TestInjectNoteIDs_DryRunThenRealRun(t *testing.T) {
	_, notesDir := mkNotesDir(t)
	withID := "---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ntags: []\n---\n# Has\n"
	writeFile(t, notesDir, "has.md", []byte(withID))
	writeFile(t, notesDir, "sub/lacks.md", []byte("---\ntags: [a]\n---\n# Lacks\n"))
	writeFile(t, notesDir, "bare.md", []byte("# Bare\n"))
	writeFile(t, notesDir, "win.md", []byte("---\r\ntags: []\r\n---\r\n# Win\r\n"))
	writeFile(t, notesDir, notes.ScratchpadRelPath, []byte("# Welcome\n"))
	writeFile(t, notesDir, ".trash/gone.md", []byte("# Gone\n"))
	writeFile(t, notesDir, ".hidden.md", []byte("# Hidden\n"))
	writeFile(t, notesDir, "notes.txt", []byte("not markdown"))
	before := snapshotDir(t, notesDir)

	log, _ := newLogBuffer(t)
	dry, err := InjectNoteIDs(context.Background(), notesDir, true, log)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if got := snapshotDir(t, notesDir); len(got) != len(before) {
		t.Fatalf("dry run changed the tree")
	} else {
		for p, c := range before {
			if got[p] != c {
				t.Errorf("dry run changed %s", p)
			}
		}
	}
	if want := []string{".hidden.md", "bare.md", "scratchpad.md", "sub/lacks.md"}; strings.Join(dry.Written, ",") != strings.Join(want, ",") {
		t.Errorf("dry run Written = %v, want %v", dry.Written, want)
	}
	if strings.Join(dry.CRLF, ",") != "win.md" || dry.Scanned != 6 || !dry.Changed() {
		t.Errorf("dry run report = %+v", dry)
	}

	applied, err := InjectNoteIDs(context.Background(), notesDir, false, log)
	if err != nil {
		t.Fatalf("real run: %v", err)
	}
	if strings.Join(applied.Written, ",") != strings.Join(dry.Written, ",") {
		t.Errorf("real run Written = %v, dry run said %v", applied.Written, dry.Written)
	}
	after := snapshotDir(t, notesDir)
	for p, c := range before {
		switch p {
		case ".hidden.md", "bare.md", "scratchpad.md", "sub/lacks.md":
			raw, found := markdown.ReadID([]byte(after[p]))
			id, perr := notes.ParseID(raw)
			if !found || perr != nil {
				t.Errorf("%s: id after run = %q, %v", p, raw, found)
			}
			// The only change is the one id line.
			stripped := strings.Replace(after[p], "id: "+id.String()+"\n", "", 1)
			if p != "sub/lacks.md" {
				stripped = strings.TrimPrefix(stripped, "---\n---\n")
			}
			if stripped != c {
				t.Errorf("%s changed beyond the id line:\n before: %q\n after:  %q", p, c, after[p])
			}
		default:
			if after[p] != c {
				t.Errorf("%s was touched: %q", p, after[p])
			}
		}
	}
	if raw, _ := markdown.ReadID([]byte(after["scratchpad.md"])); raw != notes.ScratchpadID.String() {
		t.Errorf("scratchpad id = %q, want the fixed id", raw)
	}

	again, err := InjectNoteIDs(context.Background(), notesDir, false, log)
	if err != nil || again.Changed() || len(again.CRLF) != 1 {
		t.Errorf("second run = %+v, %v; want nothing to write", again, err)
	}
}

func TestInjectNoteIDs_ReportsDuplicatesAndMalformed(t *testing.T) {
	_, notesDir := mkNotesDir(t)
	twin := "---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\n# Twin\n"
	writeFile(t, notesDir, "a.md", []byte(twin))
	writeFile(t, notesDir, "b.md", []byte(twin))
	writeFile(t, notesDir, "c.md", []byte("---\nid: nope\n---\n# C\n"))

	log, _ := newLogBuffer(t)
	report, err := InjectNoteIDs(context.Background(), notesDir, false, log)
	if err != nil {
		t.Fatal(err)
	}
	if got := report.Duplicates["01ARZ3NDEKTSV4RRFFQ69G5FAV"]; strings.Join(got, ",") != "a.md,b.md" {
		t.Errorf("Duplicates = %v", report.Duplicates)
	}
	if strings.Join(report.Written, ",") != "c.md" {
		t.Errorf("Written = %v, want the malformed note", report.Written)
	}
	c, _ := os.ReadFile(filepath.Join(notesDir, "c.md"))
	if raw, _ := markdown.ReadID(c); raw == "nope" {
		t.Errorf("malformed id survived: %q", c)
	}
}

func TestInjectNoteIDsMigration_RunsOnceAndRecordsMarker(t *testing.T) {
	db := openMigrationDB(t)
	_, notesDir := mkNotesDir(t)
	writeFile(t, notesDir, "a.md", []byte("# A\n"))
	log, _ := newLogBuffer(t)

	if err := InjectNoteIDsMigration(context.Background(), db, notesDir, log); err != nil {
		t.Fatalf("first run: %v", err)
	}
	if !hasNoteIDMarker(t, db) {
		t.Fatalf("marker not recorded")
	}
	a, _ := os.ReadFile(filepath.Join(notesDir, "a.md"))
	if _, found := markdown.ReadID(a); !found {
		t.Fatalf("a.md got no id: %q", a)
	}

	writeFile(t, notesDir, "b.md", []byte("# B\n"))
	if err := InjectNoteIDsMigration(context.Background(), db, notesDir, log); err != nil {
		t.Fatalf("second run: %v", err)
	}
	b, _ := os.ReadFile(filepath.Join(notesDir, "b.md"))
	if _, found := markdown.ReadID(b); found {
		t.Errorf("the walk ran again after the marker: %q", b)
	}
}

func TestInjectNoteIDsMigration_WriteFailureLeavesNoMarker(t *testing.T) {
	db := openMigrationDB(t)
	_, notesDir := mkNotesDir(t)
	writeFile(t, notesDir, "a.md", []byte("# A\n"))
	log, _ := newLogBuffer(t)

	atomicWriteHookMu.Lock()
	atomicWriteHook = func(string, []byte) error { return os.ErrPermission }
	atomicWriteHookMu.Unlock()
	t.Cleanup(func() {
		atomicWriteHookMu.Lock()
		atomicWriteHook = nil
		atomicWriteHookMu.Unlock()
	})

	if err := InjectNoteIDsMigration(context.Background(), db, notesDir, log); err == nil {
		t.Fatalf("write failure was swallowed")
	}
	if hasNoteIDMarker(t, db) {
		t.Errorf("marker recorded after a failed walk")
	}
}

func TestInjectNoteIDs_SkipsAttachments(t *testing.T) {
	_, notesDir := mkNotesDir(t)
	writeFile(t, notesDir, "attachments/readme.md", []byte("# Readme\n"))
	writeFile(t, notesDir, "sub/attachments/x.md", []byte("# X\n"))
	writeFile(t, notesDir, "note.md", []byte("# Note\n"))
	before := snapshotDir(t, notesDir)

	log, _ := newLogBuffer(t)
	report, err := InjectNoteIDs(context.Background(), notesDir, false, log)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(report.Written, ",") != "note.md" {
		t.Errorf("Written = %v, want only note.md", report.Written)
	}
	after := snapshotDir(t, notesDir)
	for _, p := range []string{"attachments/readme.md", "sub/attachments/x.md"} {
		if after[p] != before[p] {
			t.Errorf("%s was touched: %q", p, after[p])
		}
	}
}

package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/matthewoden/jasper/backend/internal/markdown"
)

func writeVaultNote(t *testing.T, dataDir, rel, content string) string {
	t.Helper()
	full := filepath.Join(dataDir, "notes", rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return full
}

func TestCheckNoteIDs(t *testing.T) {
	dir := t.TempDir()
	writeVaultNote(t, dir, "ok.md", "---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\n# Ok\n")
	if c := checkNoteIDs(dir); c.Status != "ok" {
		t.Errorf("all ids present: %+v", c)
	}

	writeVaultNote(t, dir, "missing.md", "# Missing\n")
	writeVaultNote(t, dir, "twin.md", "---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\n# Twin\n")
	c := checkNoteIDs(dir)
	if c.Status != "fail" {
		t.Fatalf("want fail, got %+v", c)
	}
	for _, want := range []string{"1 missing an id", "jasper migrate-ids", "ok.md, twin.md"} {
		if !strings.Contains(c.Hint, want) {
			t.Errorf("hint %q lacks %q", c.Hint, want)
		}
	}
}

func TestMigrateIDs_DryRunThenRun(t *testing.T) {
	dir := t.TempDir()
	orig := vaultFlag
	vaultFlag = dir
	t.Cleanup(func() { vaultFlag = orig; migrateIDsDryRun = false })

	path := writeVaultNote(t, dir, "a.md", "---\ntags: []\n---\n# A\n")
	before, _ := os.ReadFile(path)

	run := func(dryRun bool) string {
		migrateIDsDryRun = dryRun
		var out bytes.Buffer
		cmd := &cobra.Command{}
		cmd.SetContext(context.Background())
		cmd.SetOut(&out)
		cmd.SetErr(io.Discard)
		if err := runMigrateIDs(cmd, nil); err != nil {
			t.Fatalf("runMigrateIDs(dry=%v): %v", dryRun, err)
		}
		return out.String()
	}

	out := run(true)
	if !strings.Contains(out, "would write id: a.md") || !strings.Contains(out, "1 notes scanned, 1 would write an id") {
		t.Errorf("dry-run output: %q", out)
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(after, before) {
		t.Errorf("dry run wrote: %q", after)
	}

	out = run(false)
	if !strings.Contains(out, "wrote id: a.md") {
		t.Errorf("run output: %q", out)
	}
	after, _ := os.ReadFile(path)
	if _, found := markdown.ReadID(after); !found {
		t.Errorf("no id written: %q", after)
	}
}

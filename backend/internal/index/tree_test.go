package index

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newTreeFixture(t *testing.T) (*Indexer, string) {
	t.Helper()
	idx, notesDir := newTestIndexer(t)
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}
	return idx, notesDir
}

func writeFileForTree(t *testing.T, notesDir, rel, content string) {
	t.Helper()
	full := filepath.Join(notesDir, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mkdir(t *testing.T, notesDir, rel string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(notesDir, rel), 0o755); err != nil {
		t.Fatal(err)
	}
}

// TestBuildTree_EmptyVault — No notes, no folders → Tree.Root is empty
// slice (NOT nil per the wire-shape contract — the OpenAPI Tree type
// requires `root: []`).
func TestBuildTree_EmptyVault(t *testing.T) {
	t.Parallel()
	idx, _ := newTreeFixture(t)

	tree, err := idx.BuildTree(context.Background())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}
	if tree == nil {
		t.Fatalf("tree is nil")
	}
	if tree.Root == nil {
		t.Errorf("Root must be non-nil empty slice, got nil")
	}
	if len(tree.Root) != 0 {
		t.Errorf("Root len: got %d, want 0", len(tree.Root))
	}
}

// TestBuildTree_SingleNote — One note at "scratchpad.md" → Root has one
// TreeNode whose .Note.Title is "scratchpad" (filename fallback) or the
// extracted H1 if present.
func TestBuildTree_SingleNote(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTreeFixture(t)
	writeFileForTree(t, notesDir, "scratchpad.md", "# Scratchpad\n")

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	tree, err := idx.BuildTree(context.Background())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}
	if len(tree.Root) != 1 {
		t.Fatalf("Root len: got %d, want 1", len(tree.Root))
	}
	node := tree.Root[0]
	if node.Note == nil {
		t.Fatalf("Root[0] is not a Note")
	}
	if node.Folder != nil {
		t.Errorf("Root[0] also marked as Folder (tagged-union violation)")
	}
	if node.Note.Title != "Scratchpad" {
		t.Errorf("Title: got %q, want %q", node.Note.Title, "Scratchpad")
	}
	if node.Note.Path != "scratchpad.md" {
		t.Errorf("Path: got %q, want %q", node.Note.Path, "scratchpad.md")
	}
}

// TestBuildTree_NoteInFolder — Note at "projects/jasper/design.md" →
// Root has TreeFolder "projects" with one TreeFolder child "jasper"
// with one TreeNote child "design.md".
func TestBuildTree_NoteInFolder(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTreeFixture(t)
	writeFileForTree(t, notesDir, "projects/jasper/design.md", "# Design\n")

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	tree, err := idx.BuildTree(context.Background())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}
	if len(tree.Root) != 1 {
		t.Fatalf("Root len: got %d, want 1", len(tree.Root))
	}
	projects := tree.Root[0].Folder
	if projects == nil {
		t.Fatalf("Root[0] not a Folder")
	}
	if projects.Name != "projects" || projects.Path != "projects" {
		t.Errorf("projects: name=%q path=%q", projects.Name, projects.Path)
	}
	if len(projects.Children) != 1 {
		t.Fatalf("projects.Children len: got %d, want 1", len(projects.Children))
	}
	jasper := projects.Children[0].Folder
	if jasper == nil {
		t.Fatalf("projects/Children[0] not a Folder")
	}
	if jasper.Name != "jasper" || jasper.Path != "projects/jasper" {
		t.Errorf("jasper: name=%q path=%q", jasper.Name, jasper.Path)
	}
	if len(jasper.Children) != 1 {
		t.Fatalf("jasper.Children len: got %d, want 1", len(jasper.Children))
	}
	design := jasper.Children[0].Note
	if design == nil {
		t.Fatalf("jasper/Children[0] not a Note")
	}
	if design.Path != "projects/jasper/design.md" {
		t.Errorf("design.Path: got %q, want %q", design.Path, "projects/jasper/design.md")
	}
}

// TestBuildTree_EmptyFolder — mkdir notes/ideas/ with no contents →
// Root has TreeFolder "ideas" with empty Children slice.
func TestBuildTree_EmptyFolder(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTreeFixture(t)
	mkdir(t, notesDir, "ideas")

	tree, err := idx.BuildTree(context.Background())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}
	if len(tree.Root) != 1 {
		t.Fatalf("Root len: got %d, want 1", len(tree.Root))
	}
	ideas := tree.Root[0].Folder
	if ideas == nil {
		t.Fatalf("Root[0] not a Folder")
	}
	if ideas.Name != "ideas" || ideas.Path != "ideas" {
		t.Errorf("ideas: name=%q path=%q", ideas.Name, ideas.Path)
	}
	if ideas.Children == nil {
		t.Errorf("Children must be non-nil empty slice, got nil")
	}
	if len(ideas.Children) != 0 {
		t.Errorf("Children len: got %d, want 0", len(ideas.Children))
	}
}

// TestBuildTree_FoldersBeforeNotes — Insert "a-note.md", mkdir
// "z-folder/" → at root level, "z-folder" appears BEFORE "a-note"
// (folders-before-notes invariant).
func TestBuildTree_FoldersBeforeNotes(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTreeFixture(t)
	writeFileForTree(t, notesDir, "a-note.md", "")
	mkdir(t, notesDir, "z-folder")

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	tree, err := idx.BuildTree(context.Background())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}
	if len(tree.Root) != 2 {
		t.Fatalf("Root len: got %d, want 2", len(tree.Root))
	}
	if tree.Root[0].Folder == nil || tree.Root[0].Folder.Name != "z-folder" {
		t.Errorf("Root[0]: expected folder z-folder, got %+v", tree.Root[0])
	}
	if tree.Root[1].Note == nil {
		t.Errorf("Root[1]: expected note, got %+v", tree.Root[1])
	}
}

// TestBuildTree_AlphabeticalWithinKind — Insert "b-note.md",
// "a-note.md" → at root level, "a-note" comes before "b-note".
func TestBuildTree_AlphabeticalWithinKind(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTreeFixture(t)
	writeFileForTree(t, notesDir, "b-note.md", "")
	writeFileForTree(t, notesDir, "a-note.md", "")

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	tree, err := idx.BuildTree(context.Background())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}
	if len(tree.Root) != 2 {
		t.Fatalf("Root len: got %d, want 2", len(tree.Root))
	}
	if tree.Root[0].Note == nil || tree.Root[0].Note.Title != "a-note" {
		t.Errorf("Root[0]: got %+v", tree.Root[0])
	}
	if tree.Root[1].Note == nil || tree.Root[1].Note.Title != "b-note" {
		t.Errorf("Root[1]: got %+v", tree.Root[1])
	}
}

// TestBuildTree_DeepNesting — "a/b/c/d/e/f.md" → 5 nested folder
// levels with the note at the bottom; iterating the tree reaches the
// note in 6 hops.
func TestBuildTree_DeepNesting(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTreeFixture(t)
	writeFileForTree(t, notesDir, "a/b/c/d/e/f.md", "")

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	tree, err := idx.BuildTree(context.Background())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}
	cur := tree.Root
	for i, want := range []string{"a", "b", "c", "d", "e"} {
		if len(cur) != 1 {
			t.Fatalf("level %d len: got %d, want 1", i, len(cur))
		}
		f := cur[0].Folder
		if f == nil {
			t.Fatalf("level %d not a folder", i)
		}
		if f.Name != want {
			t.Fatalf("level %d name: got %q, want %q", i, f.Name, want)
		}
		cur = f.Children
	}
	if len(cur) != 1 {
		t.Fatalf("leaf level len: got %d, want 1", len(cur))
	}
	leaf := cur[0]
	if leaf.Note == nil {
		t.Fatalf("leaf is not a note")
	}
	if leaf.Note.Path != "a/b/c/d/e/f.md" {
		t.Errorf("leaf path: got %q", leaf.Note.Path)
	}
}

// TestBuildTree_SkipsDotDirs — mkdir notes/.git/ + add a file inside;
// mkdir notes/.obsidian/; tree has neither.
func TestBuildTree_SkipsDotDirs(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTreeFixture(t)
	writeFileForTree(t, notesDir, ".git/HEAD", "ref: refs/heads/main")
	mkdir(t, notesDir, ".obsidian")
	writeFileForTree(t, notesDir, "real.md", "")

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	tree, err := idx.BuildTree(context.Background())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}
	for _, n := range tree.Root {
		if n.Folder != nil {
			if n.Folder.Name == ".git" || n.Folder.Name == ".obsidian" {
				t.Errorf("dotdir leaked into tree: %s", n.Folder.Name)
			}
		}
	}

	if len(tree.Root) != 1 {
		t.Errorf("tree root len: got %d, want 1 (only real.md)", len(tree.Root))
	}
}

// TestBuildTree_AttachmentsFolderVisible — mkdir
// notes/projects/jasper/attachments/, add a non-.md file inside; tree
// shows projects/jasper as a folder AND includes the attachments folder node.
//
// Updated per Plan 07-20 (UAT #13): attachments folders are now VISIBLE
// in the tree as browsable folder nodes. The indexer's note-walk (walk.go)
// is UNCHANGED — attachments/ contents are NOT indexed as notes.
func TestBuildTree_AttachmentsFolderVisible(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTreeFixture(t)
	writeFileForTree(t, notesDir, "projects/jasper/note.md", "")
	writeFileForTree(t, notesDir, "projects/jasper/attachments/img.png", "binary")

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	tree, err := idx.BuildTree(context.Background())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}

	if len(tree.Root) != 1 || tree.Root[0].Folder == nil {
		t.Fatalf("expected projects folder at root")
	}
	projects := tree.Root[0].Folder
	if len(projects.Children) != 1 || projects.Children[0].Folder == nil {
		t.Fatalf("expected jasper folder under projects")
	}
	jasper := projects.Children[0].Folder
	var foundAttachments bool
	for _, c := range jasper.Children {
		if c.Folder != nil && c.Folder.Name == "attachments" {
			foundAttachments = true
		}
	}
	if !foundAttachments {
		t.Errorf("attachments folder NOT in tree (Plan 07-20 UAT #13: should be visible)")
	}
}

// TestBuildTree_AttachmentsFolderVisibleAtRoot — mkdir notes/attachments/,
// add a non-.md file inside; tree root includes the attachments folder node.
//
// This covers the root-level case (no parent folder nesting).
func TestBuildTree_AttachmentsFolderVisibleAtRoot(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTreeFixture(t)
	writeFileForTree(t, notesDir, "attachments/photo.png", "binary")
	writeFileForTree(t, notesDir, "regular.md", "# Regular Note\n")

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	tree, err := idx.BuildTree(context.Background())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}

	var foundAttachments bool
	for _, n := range tree.Root {
		if n.Folder != nil && n.Folder.Name == "attachments" {
			foundAttachments = true
		}
	}
	if !foundAttachments {
		t.Errorf("root-level attachments folder NOT in tree (Plan 07-20 UAT #13: should be visible)")
	}
}

// TestBuildTree_LocksFolderName — Build tree; assert TreeFolder for
// "projects/jasper" has Name == "jasper" (last segment), Path ==
// "projects/jasper".
func TestBuildTree_LocksFolderName(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTreeFixture(t)
	writeFileForTree(t, notesDir, "projects/jasper/x.md", "")

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	tree, err := idx.BuildTree(context.Background())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}
	projects := tree.Root[0].Folder
	if projects.Name != "projects" || projects.Path != "projects" {
		t.Errorf("projects: name=%q path=%q", projects.Name, projects.Path)
	}
	jasper := projects.Children[0].Folder
	if jasper.Name != "jasper" || jasper.Path != "projects/jasper" {
		t.Errorf("jasper: name=%q path=%q", jasper.Name, jasper.Path)
	}
}

// TestBuildTree_FilesVisible — Non-markdown files inside notes/ appear as
// TreeFile entries in the tree. Notes/folders continue to appear unchanged.
// This test covers the UAT-2 R1-7 fix (Plan 07-26) — surfacing all files,
// not just markdown notes, in the sidebar tree.
func TestBuildTree_FilesVisible(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTreeFixture(t)

	writeFileForTree(t, notesDir, "foo.md", "# Foo\n")
	writeFileForTree(t, notesDir, "img.png", "fake-png")
	writeFileForTree(t, notesDir, "sub/doc.pdf", "fake-pdf")
	writeFileForTree(t, notesDir, "sub/attachments/x.png", "fake-png")

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	tree, err := idx.BuildTree(context.Background())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}

	findFile := func(nodes []TreeNode, path string) *TreeFile {
		for _, n := range nodes {
			if n.File != nil && n.File.Path == path {
				return n.File
			}
		}
		return nil
	}

	imgFile := findFile(tree.Root, "img.png")
	if imgFile == nil {
		t.Errorf("img.png NOT in root tree (expected as TreeFile)")
	} else {
		if imgFile.Name != "img.png" {
			t.Errorf("img.png name: got %q, want %q", imgFile.Name, "img.png")
		}
	}

	var foundFooNote bool
	for _, n := range tree.Root {
		if n.Note != nil && n.Note.Path == "foo.md" {
			foundFooNote = true
		}
	}
	if !foundFooNote {
		t.Errorf("foo.md note NOT in root tree")
	}

	var subFolder *TreeFolder
	for _, n := range tree.Root {
		if n.Folder != nil && n.Folder.Name == "sub" {
			subFolder = n.Folder
		}
	}
	if subFolder == nil {
		t.Fatalf("sub/ folder NOT in root tree")
	}

	docFile := findFile(subFolder.Children, "sub/doc.pdf")
	if docFile == nil {
		t.Errorf("sub/doc.pdf NOT in sub/ folder (expected as TreeFile)")
	} else {
		if docFile.Name != "doc.pdf" {
			t.Errorf("doc.pdf name: got %q, want %q", docFile.Name, "doc.pdf")
		}
	}

	var attachFolder *TreeFolder
	for _, n := range subFolder.Children {
		if n.Folder != nil && n.Folder.Name == "attachments" {
			attachFolder = n.Folder
		}
	}
	if attachFolder == nil {
		t.Fatalf("sub/attachments/ folder NOT in sub/ folder")
	}

	xFile := findFile(attachFolder.Children, "sub/attachments/x.png")
	if xFile == nil {
		t.Errorf("sub/attachments/x.png NOT in attachments/ folder (expected as TreeFile)")
	} else {
		if xFile.Name != "x.png" {
			t.Errorf("x.png name: got %q, want %q", xFile.Name, "x.png")
		}
	}
}

// TestBuildTree_NoteUpdatedAtFromIndex — The TreeNote.UpdatedAt is
// derived from the index row's mtime (NOT a fresh file stat).
func TestBuildTree_NoteUpdatedAtFromIndex(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTreeFixture(t)

	pinned := time.Unix(1700123456, 0)
	full := filepath.Join(notesDir, "x.md")
	if err := os.WriteFile(full, []byte("# X"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(full, pinned, pinned); err != nil {
		t.Fatal(err)
	}

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	tree, err := idx.BuildTree(context.Background())
	if err != nil {
		t.Fatalf("BuildTree: %v", err)
	}
	if len(tree.Root) != 1 {
		t.Fatalf("Root len: got %d, want 1", len(tree.Root))
	}
	note := tree.Root[0].Note
	if note == nil {
		t.Fatalf("Root[0] not a Note")
	}
	if note.UpdatedAt.Unix() != pinned.Unix() {
		t.Errorf("UpdatedAt: got %d, want %d", note.UpdatedAt.Unix(), pinned.Unix())
	}
}

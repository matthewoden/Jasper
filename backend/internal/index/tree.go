package index

import (
	"context"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
)

// TreeFolder is a folder node. Children are sorted: folders first,
// then notes + files merged alphabetically; within folders alphabetical
// by Name. Children is non-nil — an empty folder has Children
// == []TreeNode{} so the handler can omit the children array OR emit
// `[]` based on context (the wire-shape rule lives in Plan 03-04).
type TreeFolder struct {
	Path     string
	Name     string
	Children []TreeNode
}

// TreeNote is a leaf note node. UpdatedAt is derived from the index's
// mtime_unix column (NOT the filesystem) so the entire tree projection
// is one consistent SELECT result.
type TreeNote struct {
	ID        uuid.UUID
	Path      string
	Title     string
	UpdatedAt time.Time
}

// TreeFile is a leaf non-markdown file node. These are files that exist
// on disk under notes/ but are not indexed as notes (images, PDFs,
// attachments, etc.). Surfaced in the tree so users can browse and open
// files directly from the sidebar (Plan 07-26 / UAT-2 R1-7).
//
// SizeBytes and ContentType are intentionally left zero / "" in v1 for
// performance — no per-file os.Stat or MIME sniff during tree building.
// The file-stream endpoint (GET /api/v1/attachments/{noteId}/{filename})
// returns Content-Type in its response headers.
type TreeFile struct {
	Path        string // canonical relative path under notes/
	Name        string // basename (last path segment)
	SizeBytes   int64  // optional; 0 if not stat'd
	ContentType string // optional; "" if not sniffed
}

// TreeNode is the tagged-union node — exactly one of Folder / Note / File
// is non-nil. The handler in Plan 03-04 translates this into the wire's
// `kind` discriminator.
type TreeNode struct {
	Folder *TreeFolder
	Note   *TreeNote
	File   *TreeFile // non-markdown file (Plan 07-26 / UAT-2 R1-7)
}

// Tree is the top-level projection. Root is the slice of children of
// notes/ (the vault root itself is implicit — the handler does not
// expose a "root folder" node).
type Tree struct {
	Root []TreeNode
}

// BuildTree returns the nested folder/note structure for GET /tree.
// Reads notes via x.List (already path-ASC sorted); discovers empty
// folders by walking notesDir with the same skip rules as walk.go
// (dotdirs, non-md files). Merges into a single in-memory tree, sorts
// each level (folders before notes/files; alphabetical within each kind),
// and returns *Tree.
//
// Plan 07-26 / UAT-2 R1-7: non-markdown files are now surfaced as
// TreeNode{File: ...} entries alongside notes and folders.
//
// Performance: O(N + D + F) where N = note count, D = directory count,
// F = non-markdown file count. For a 1,000-note vault well under PERF-02.
func (x *Indexer) BuildTree(ctx context.Context) (*Tree, error) {
	notesSummaries, err := x.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("BuildTree: list notes: %w", err)
	}

	folderPaths, err := listFolders(ctx, x.NotesDir)
	if err != nil {
		return nil, fmt.Errorf("BuildTree: list folders: %w", err)
	}

	files, err := listFiles(ctx, x.NotesDir)
	if err != nil {
		return nil, fmt.Errorf("BuildTree: list files: %w", err)
	}

	folders := map[string]*TreeFolder{
		"": {Path: "", Name: "", Children: []TreeNode{}},
	}

	for _, fp := range folderPaths {
		ensureFolder(folders, fp)
	}

	for _, s := range notesSummaries {
		dir := canonicalDir(s.Path)
		parent := ensureFolder(folders, dir)
		parent.Children = append(parent.Children, TreeNode{
			Note: &TreeNote{
				ID:        s.ID,
				Path:      s.Path,
				Title:     s.Title,
				UpdatedAt: s.UpdatedAt,
			},
		})
	}

	for i := range files {
		f := &files[i]
		dir := canonicalDir(f.Path)
		parent := ensureFolder(folders, dir)
		parent.Children = append(parent.Children, TreeNode{File: f})
	}

	folderKeys := make([]string, 0, len(folders))
	for k := range folders {
		folderKeys = append(folderKeys, k)
	}
	sort.Strings(folderKeys)
	for _, k := range folderKeys {
		if k == "" {
			continue
		}
		f := folders[k]
		parentKey := ""
		if i := strings.LastIndex(k, "/"); i >= 0 {
			parentKey = k[:i]
		}
		parent := folders[parentKey]
		parent.Children = append(parent.Children, TreeNode{Folder: f})
	}

	for _, f := range folders {
		sortChildren(f.Children)
	}

	root := folders[""].Children
	if root == nil {
		root = []TreeNode{}
	}
	return &Tree{Root: root}, nil
}

func ensureFolder(folders map[string]*TreeFolder, folderPath string) *TreeFolder {
	if f, ok := folders[folderPath]; ok {
		return f
	}
	if folderPath == "" {
		root := &TreeFolder{Path: "", Name: "", Children: []TreeNode{}}
		folders[""] = root
		return root
	}

	parentPath := ""
	name := folderPath
	if i := strings.LastIndex(folderPath, "/"); i >= 0 {
		parentPath = folderPath[:i]
		name = folderPath[i+1:]
	}

	_ = ensureFolder(folders, parentPath)
	f := &TreeFolder{
		Path:     folderPath,
		Name:     name,
		Children: []TreeNode{},
	}
	folders[folderPath] = f
	return f
}

func canonicalDir(notePath string) string {
	i := strings.LastIndex(notePath, "/")
	if i < 0 {
		return ""
	}
	return notePath[:i]
}

func sortChildren(children []TreeNode) {
	sort.SliceStable(children, func(i, j int) bool {
		if (children[i].Folder != nil) != (children[j].Folder != nil) {
			return children[i].Folder != nil
		}
		return childKey(children[i]) < childKey(children[j])
	})
}

func childKey(n TreeNode) string {
	if n.Folder != nil {
		return n.Folder.Name
	}
	if n.Note != nil {
		return n.Note.Title
	}
	if n.File != nil {
		return n.File.Name
	}
	return ""
}

func listFolders(ctx context.Context, notesDir string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(notesDir, func(path string, d fs.DirEntry, err error) error {
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		if err != nil {
			if path == notesDir {
				return fmt.Errorf("walk %q: %w", notesDir, err)
			}
			return nil
		}
		if !d.IsDir() {
			return nil
		}

		if path == notesDir {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			return filepath.SkipDir
		}

		rel, err := filepath.Rel(notesDir, path)
		if err != nil {
			return nil
		}

		canonical, cerr := fsstore.Canonicalize(notesDir, rel)
		if cerr != nil {
			return nil
		}
		canonRel, rerr := filepath.Rel(notesDir, canonical)
		if rerr != nil {
			return nil
		}
		out = append(out, filepath.ToSlash(canonRel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func listFiles(ctx context.Context, notesDir string) ([]TreeFile, error) {
	var out []TreeFile
	err := filepath.WalkDir(notesDir, func(path string, d fs.DirEntry, err error) error {
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		if err != nil {
			if path == notesDir {
				return fmt.Errorf("walk %q: %w", notesDir, err)
			}
			return nil
		}
		if d.IsDir() {
			if path == notesDir {
				return nil
			}

			if strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}

		name := d.Name()
		if strings.HasPrefix(name, ".") {
			return nil
		}

		if strings.HasSuffix(strings.ToLower(name), ".md") {
			return nil
		}
		rel, err := filepath.Rel(notesDir, path)
		if err != nil {
			return nil
		}

		canonical, cerr := fsstore.Canonicalize(notesDir, rel)
		if cerr != nil {
			return nil
		}
		canonRel, rerr := filepath.Rel(notesDir, canonical)
		if rerr != nil {
			return nil
		}
		slashPath := filepath.ToSlash(canonRel)
		out = append(out, TreeFile{
			Path: slashPath,
			Name: filepath.Base(slashPath),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

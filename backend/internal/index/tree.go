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

// Tree types — the in-memory projection of the SQLite index + the
// filesystem directory listing into the nested structure consumed by
// the API layer's GET /tree handler (Plan 03-04 wires the wire-shape
// translation). The shape mirrors openapi.yaml's TreeNode oneOf union
// (FolderNode + NoteNode + FileNode discriminated on `kind`), but stays
// API-package-free so the index can be tested without dragging the
// API codegen into the same compile unit.
//
// Tagged-union semantics: exactly one of TreeNode.Folder /
// TreeNode.Note / TreeNode.File is non-nil for any constructed node.
// The handler in Plan 03-04 type-switches on the non-nil field to set
// the wire-shape `kind` discriminator.

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

	// Empty-folder discovery: walk the FS for directory entries that
	// pass the same skip rules as walk.go. We collect ALL non-skipped
	// directories (including non-empty ones) — the merge step is
	// idempotent on add-folder, so the extra work is harmless and
	// simpler than tracking emptiness separately.
	folderPaths, err := listFolders(ctx, x.NotesDir)
	if err != nil {
		return nil, fmt.Errorf("BuildTree: list folders: %w", err)
	}

	// Non-markdown file discovery (Plan 07-26 / UAT-2 R1-7).
	files, err := listFiles(ctx, x.NotesDir)
	if err != nil {
		return nil, fmt.Errorf("BuildTree: list files: %w", err)
	}

	// In-memory tree representation: map[canonical-folder-path] →
	// *TreeFolder. The root folder is keyed by "" (empty string).
	folders := map[string]*TreeFolder{
		"": {Path: "", Name: "", Children: []TreeNode{}},
	}

	// Ensure every folder discovered on disk has a node (even if it
	// has zero notes inside). Order does not matter — we sort at the end.
	for _, fp := range folderPaths {
		ensureFolder(folders, fp)
	}

	// Insert notes. For each note, ensure all ancestor folders exist
	// (this catches the "folder exists in index but not on disk"
	// degenerate case where a directory was deleted while notes
	// referenced it; the next reconcile heals).
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

	// Insert non-markdown files (Plan 07-26 / UAT-2 R1-7).
	// Each file is placed under its parent directory's folder node.
	for i := range files {
		f := &files[i]
		dir := canonicalDir(f.Path)
		parent := ensureFolder(folders, dir)
		parent.Children = append(parent.Children, TreeNode{File: f})
	}

	// Wire each folder into its parent's Children. Walk in path order
	// so deeper folders attach AFTER their parents are present.
	folderKeys := make([]string, 0, len(folders))
	for k := range folders {
		folderKeys = append(folderKeys, k)
	}
	sort.Strings(folderKeys)
	for _, k := range folderKeys {
		if k == "" {
			continue // root has no parent
		}
		f := folders[k]
		parentKey := ""
		if i := strings.LastIndex(k, "/"); i >= 0 {
			parentKey = k[:i]
		}
		parent := folders[parentKey]
		parent.Children = append(parent.Children, TreeNode{Folder: f})
	}

	// Sort children at every level: folders first (sorted by Name),
	// then notes + files merged alphabetically (so "report.md" and
	// "report.pdf" appear adjacent).
	for _, f := range folders {
		sortChildren(f.Children)
	}

	root := folders[""].Children
	if root == nil {
		root = []TreeNode{}
	}
	return &Tree{Root: root}, nil
}

// ensureFolder inserts (and returns) the *TreeFolder for the given
// canonical folder path. Recursive: if the parent does not yet exist,
// it is inserted first. The root key "" is pre-populated.
func ensureFolder(folders map[string]*TreeFolder, folderPath string) *TreeFolder {
	if f, ok := folders[folderPath]; ok {
		return f
	}
	if folderPath == "" {
		// Should already exist from BuildTree's seed; defensive.
		root := &TreeFolder{Path: "", Name: "", Children: []TreeNode{}}
		folders[""] = root
		return root
	}
	// Compute parent path: chop the last "/" segment.
	parentPath := ""
	name := folderPath
	if i := strings.LastIndex(folderPath, "/"); i >= 0 {
		parentPath = folderPath[:i]
		name = folderPath[i+1:]
	}
	// Recursively ensure parent exists (does NOT wire children yet —
	// that happens in BuildTree's parent-attach loop).
	_ = ensureFolder(folders, parentPath)
	f := &TreeFolder{
		Path:     folderPath,
		Name:     name,
		Children: []TreeNode{},
	}
	folders[folderPath] = f
	return f
}

// canonicalDir returns the parent directory (canonical relpath) of
// notePath. For a top-level note like "scratchpad.md" the parent is "".
// Mirrors path.Dir but normalizes "." → "".
func canonicalDir(notePath string) string {
	i := strings.LastIndex(notePath, "/")
	if i < 0 {
		return ""
	}
	return notePath[:i]
}

// sortChildren orders children in-place: folders before notes+files,
// notes and files merged alphabetically by display key. Stable sort so
// subsequent passes do not reshuffle ties.
func sortChildren(children []TreeNode) {
	sort.SliceStable(children, func(i, j int) bool {
		// Folders before notes+files.
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

// listFolders walks notesDir collecting every directory path under it
// (relative to notesDir, NFC + lowercased via Canonicalize), applying
// the same skip rules as walk.go: dotdirs (`.git`, `.obsidian`, etc.).
// Non-md files are not relevant to folder discovery and skipped implicitly.
// Returns a slice of canonical relative folder paths (NOT including notesDir
// itself).
//
// NOTE (Plan 07-20 / UAT #13 fix): attachments/ subfolders WERE skipped
// here pre-Plan-07-20; they now appear in the tree as browsable folder nodes.
// The indexer's note-walk (walk.go) still skips attachments/ contents —
// files inside attachments/ are not indexed as notes; only the folder itself
// appears as a TreeNode in the response.
//
// Errors during the walk are best-effort: a single bad path is skipped
// rather than aborting the walk, mirroring WalkVault's posture.
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
		// Skip notesDir itself — only collect descendants.
		if path == notesDir {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			return filepath.SkipDir
		}
		// NOTE: "attachments" folders are intentionally NOT skipped here
		// (Plan 07-20 / UAT #13 fix). They appear as folder nodes in the
		// tree so the user can browse them. The indexer's walk.go still
		// skips their CONTENTS for note discovery — only the folder itself
		// is surfaced.
		rel, err := filepath.Rel(notesDir, path)
		if err != nil {
			return nil
		}
		// Canonicalize for NFC + lowercase consistency with the index.
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

// listFiles walks notesDir collecting every non-markdown, non-dotfile
// regular file path under it (relative to notesDir, NFC + lowercased via
// Canonicalize). Applies the same dotdir skip rules as listFolders and
// walk.go. Markdown files are skipped because they are indexed as notes
// via x.List. Dot-prefixed files are skipped as implementation detail.
//
// Returns a slice of TreeFile values — path and name only; SizeBytes and
// ContentType are deferred to v2 (no per-file stat or MIME sniff for
// performance on large vaults).
//
// Plan 07-26 / UAT-2 R1-7: closes the v1 limitation noted in
// 07-20-SUMMARY's "Known v1 Limitation" block.
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
			// Skip notesDir itself.
			if path == notesDir {
				return nil
			}
			// Skip dotdirs (matches listFolders rule).
			if strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		// Regular file: skip dotfiles.
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			return nil
		}
		// Skip markdown files — those come from x.List as TreeNote.
		if strings.HasSuffix(strings.ToLower(name), ".md") {
			return nil
		}
		rel, err := filepath.Rel(notesDir, path)
		if err != nil {
			return nil
		}
		// Canonicalize for NFC + lowercase consistency with the index.
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
			// SizeBytes and ContentType: deferred to v2; see type comment.
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

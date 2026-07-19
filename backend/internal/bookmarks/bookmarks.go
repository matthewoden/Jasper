// Package bookmarks owns Jasper's per-vault bookmarks file
// (<dataDir>/.jasper/bookmarks.json). Stateless per-call — no in-memory
// cache, no vault-swap teardown needed (mirrors internal/config).
//
// Bookmarks are keyed by stable note UUID (not path), so a bookmark
// survives note rename/move (BOOK-04). A bookmark whose NoteID no longer
// resolves in the notes.Registry is dropped on load (D-04 auto-prune).
package bookmarks

import "path/filepath"

// Bookmarks is the on-disk document shape for bookmarks.json.
type Bookmarks struct {
	Folders   []Folder   `json:"folders"`
	Bookmarks []Bookmark `json:"bookmarks"`
}

// Folder is a virtual grouping label for bookmarks — NOT a filesystem
// folder. Name has no filesystem-legal-character restrictions.
type Folder struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Bookmark pins a single note by its stable UUID. FolderID is nil for a
// top-level (ungrouped) bookmark; otherwise it references a Folder.ID in
// the same document.
type Bookmark struct {
	ID       string  `json:"id"`
	NoteID   string  `json:"noteId"`
	FolderID *string `json:"folderId"`
	Order    int     `json:"order"`
}

// bookmarksPath returns <dataDir>/.jasper/bookmarks.json — the on-disk
// location of the per-vault bookmarks file. Mirrors config.configPath.
func bookmarksPath(dataDir string) string {
	return filepath.Join(dataDir, ".jasper", "bookmarks.json")
}

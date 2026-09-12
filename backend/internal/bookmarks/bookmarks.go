// Package bookmarks owns Jasper's per-vault bookmarks file
// (<dataDir>/.jasper/bookmarks.json). Stateless per-call — no in-memory
// cache, no vault-swap teardown needed (mirrors internal/config).
//
// Bookmarks are keyed by stable note UUID (not path), so a bookmark
// survives note rename/move (BOOK-04). A bookmark whose NoteID no longer
// resolves in the notes.Registry is dropped on load (auto-prune).
//
// A note's UUID is only as durable as the index it lives in: a full
// rebuild (POST /admin/reindex, or the reset-and-rebuild recovery path)
// DROPs the notes table and re-mints every id, which made this document —
// which is source of truth, not a derived surface — collateral damage.
// Each row therefore also carries the note's path as a recovery hint, so
// Load can re-resolve identity instead of pruning. See Bookmark.Path.
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
//
// Path is the note's canonical relPath, written at Add time and refreshed
// by Load whenever the id resolves somewhere else (so a rename does not
// leave a stale hint behind). It is a fallback, never the key: NoteID is
// tried first, so rename and move still work through the id. Empty for a
// row written before the field existed — such a row still prunes.
//
// Path is deliberately absent from the wire type: it is how storage
// recovers identity, not something a client should key off.
type Bookmark struct {
	ID       string  `json:"id"`
	NoteID   string  `json:"noteId"`
	FolderID *string `json:"folderId"`
	Order    int     `json:"order"`
	Path     string  `json:"path"`
}

// bookmarksPath returns <dataDir>/.jasper/bookmarks.json — the on-disk
// location of the per-vault bookmarks file. Mirrors config.configPath.
func bookmarksPath(dataDir string) string {
	return filepath.Join(dataDir, ".jasper", "bookmarks.json")
}

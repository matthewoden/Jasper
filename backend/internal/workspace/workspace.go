// Package workspace owns Jasper's per-vault workspace-preferences file
// (<dataDir>/.jasper/workspace.json). Stateless per-call — no in-memory
// cache, no vault-swap teardown needed (mirrors internal/bookmarks and
// internal/config).
//
// Workspace prefs never reference note UUIDs, so unlike bookmarks this
// package has no notes.Registry dependency anywhere.
package workspace

import (
	"errors"
	"path/filepath"
)

// Workspace is the on-disk document shape for workspace.json.
type Workspace struct {
	NotesSort     string `json:"notesSort"`
	SearchSort    string `json:"searchSort"`
	RightPanel    string `json:"rightPanel"`
	BookmarksSort string `json:"bookmarksSort"`
}

// ErrInvalidSort is returned by Service setters when the requested value
// is outside the closed enum set for that field.
var ErrInvalidSort = errors.New("workspace: invalid sort value")

// validNotesSort is the closed enum of accepted notesSort values. Empty
// string is allowed and means "default".
var validNotesSort = map[string]bool{
	"":              true,
	"name-asc":      true,
	"name-desc":     true,
	"modified-desc": true,
	"modified-asc":  true,
	"created-desc":  true,
	"created-asc":   true,
}

// validBookmarksSort is the closed enum of accepted bookmarksSort values.
// It is validNotesSort plus "manual", which keeps the drag-assigned
// Bookmark.Order. Empty string is allowed and means "default".
var validBookmarksSort = map[string]bool{
	"":              true,
	"manual":        true,
	"name-asc":      true,
	"name-desc":     true,
	"modified-desc": true,
	"modified-asc":  true,
	"created-desc":  true,
	"created-asc":   true,
}

// validSearchSort is the closed enum of accepted searchSort values. Empty
// string is allowed and means "default".
var validSearchSort = map[string]bool{
	"":          true,
	"relevance": true,
	"modified":  true,
	"created":   true,
}

// validRightPanel is the closed enum of accepted rightPanel values. Empty
// string is allowed and means "default", which the client renders as
// "outline".
var validRightPanel = map[string]bool{
	"":          true,
	"outline":   true,
	"backlinks": true,
	"tags":      true,
}

// IsValidNotesSort reports whether v is inside the closed notesSort enum.
// Exposed so the API handler can validate ALL request fields up front and
// reject atomically before any setter persists or broadcasts; the
// setters keep their own checks as defense-in-depth.
func IsValidNotesSort(v string) bool { return validNotesSort[v] }

// IsValidSearchSort reports whether v is inside the closed searchSort
// enum. See IsValidNotesSort for why this is exported.
func IsValidSearchSort(v string) bool { return validSearchSort[v] }

// IsValidRightPanel reports whether v is inside the closed rightPanel
// enum. See IsValidNotesSort for why this is exported.
func IsValidRightPanel(v string) bool { return validRightPanel[v] }

// IsValidBookmarksSort reports whether v is inside the closed bookmarksSort
// enum. See IsValidNotesSort for why this is exported.
func IsValidBookmarksSort(v string) bool { return validBookmarksSort[v] }

// workspacePath returns <dataDir>/.jasper/workspace.json — the on-disk
// location of the per-vault workspace-preferences file. Mirrors
// bookmarks.bookmarksPath.
func workspacePath(dataDir string) string {
	return filepath.Join(dataDir, ".jasper", "workspace.json")
}

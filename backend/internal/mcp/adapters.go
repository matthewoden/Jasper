// Phase 8 Plan 08-09 — adapters that wrap the existing in-process
// services (index.Indexer, api.SearchNotes, api.GetAttachment) behind
// the small NotesProvider / SearchProvider / AttachmentProvider
// interfaces consumed by the MCP tools.
//
// Why adapters: the MCP tools test in isolation with fakes; the
// lifecycle composition root passes concrete adapters that funnel into
// the same code paths the HTTP API uses (no behavior divergence).
//
// Blocker 5 (per plan): notes.Service has no List method — List lives
// on the *index.Indexer. We wrap the index here.

package mcp

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// ---------- NotesProvider ----------

// notesProviderImpl wraps any object exposing List(ctx) — in production
// that's *index.Indexer. The interface is intentionally tight so test
// code can pass a fake without importing the index package.
type notesProviderImpl struct {
	idx noteLister
}

// noteLister is the only method we use from the index — keeps the
// adapter's coupling surface minimal.
type noteLister interface {
	List(ctx context.Context) ([]notes.NoteSummary, error)
}

// NewNotesProvider returns a NotesProvider backed by idx. Pass an
// *index.Indexer in production (lifecycle.go); pass a fake in tests.
func NewNotesProvider(idx noteLister) NotesProvider {
	return &notesProviderImpl{idx: idx}
}

func (n *notesProviderImpl) List(ctx context.Context) ([]notes.NoteSummary, error) {
	return n.idx.List(ctx)
}

// ---------- SearchProvider ----------

// SearchFunc is the closure type the lifecycle root passes — it wraps
// index.SearchFTS and projects notes.SearchHit → mcp.SearchHit (the
// MCP tool's wire shape). Defined as a closure so the mcp package
// doesn't have to import internal/index (and risk a cycle).
type SearchFunc func(ctx context.Context, q string, limit int) ([]SearchHit, error)

// searchAdapterImpl is a trivial wrapper that satisfies SearchProvider.
type searchAdapterImpl struct {
	fn SearchFunc
}

// NewSearchAdapter returns a SearchProvider backed by fn. fn typically
// calls index.SearchFTS and converts the rows to []SearchHit.
func NewSearchAdapter(fn SearchFunc) SearchProvider {
	return &searchAdapterImpl{fn: fn}
}

func (s *searchAdapterImpl) Search(ctx context.Context, q string, limit int) ([]SearchHit, error) {
	if s.fn == nil {
		return nil, errors.New("search adapter: no search function configured")
	}
	return s.fn(ctx, q, limit)
}

// ---------- AttachmentProvider ----------

// attachmentAdapterImpl duplicates the 5-rule path pipeline from
// api.GetAttachment so the MCP tool can read attachment bytes without
// dragging in the api package. The pipeline mirrors
// backend/internal/api/attachments.go lines 168-231 verbatim.
type attachmentAdapterImpl struct {
	notesSvc *notes.Service
	dataDir  string
}

// NewAttachmentAdapter wires an AttachmentProvider to notesSvc (for
// note → folder resolution) and dataDir (so we can compute the
// attachments directory). Mirrors api.Server's identical fields.
func NewAttachmentAdapter(notesSvc *notes.Service, dataDir string) AttachmentProvider {
	return &attachmentAdapterImpl{notesSvc: notesSvc, dataDir: dataDir}
}

// Read resolves <dataDir>/notes/<note_parent>/attachments/<filename>
// with the same 5-rule path pipeline used by api.GetAttachment.
// Returns the file bytes + a sniffed mime. Symlinks are rejected.
func (a *attachmentAdapterImpl) Read(_ context.Context, noteID, filename string) ([]byte, string, error) {
	// Step 1: resolve the note → owning folder.
	id, err := uuid.Parse(noteID)
	if err != nil {
		return nil, "", fmt.Errorf("invalid note id %q: %w", noteID, err)
	}
	summary, ok := a.notesSvc.LookupSummary(id)
	if !ok {
		return nil, "", fmt.Errorf("note not found: %s", noteID)
	}

	// Rule 1: reject path separators + '..' on the raw filename.
	if strings.ContainsAny(filename, `/\`) || strings.Contains(filename, "..") {
		return nil, "", errors.New("filename must not contain path separators or '..'")
	}
	// Rule 2: extract basename — defense in depth.
	filename = filepath.Base(filepath.Clean(filename))
	if filename == "." || filename == "/" || filename == "" {
		return nil, "", errors.New("invalid filename after clean")
	}

	// Rule 3: compute attachments dir (same formula as api.GetAttachment).
	notesRoot := filepath.Join(a.dataDir, "notes")
	noteParentDir := filepath.Dir(filepath.Join(notesRoot, summary.Path))
	attachDir := filepath.Join(noteParentDir, "attachments")

	// Rule 4: prefix-check the final path so it can't escape attachDir.
	finalPath := filepath.Join(attachDir, filename)
	cleanFinal := filepath.Clean(finalPath)
	cleanAttach := filepath.Clean(attachDir) + string(os.PathSeparator)
	if !strings.HasPrefix(cleanFinal, cleanAttach) {
		return nil, "", errors.New("filename escapes attachments directory")
	}

	// Rule 5: Lstat (NOT Stat) — symlinks reject.
	fi, lerr := os.Lstat(cleanFinal)
	if lerr != nil {
		if errors.Is(lerr, fs.ErrNotExist) {
			return nil, "", fmt.Errorf("attachment not found: %s", filename)
		}
		return nil, "", fmt.Errorf("stat attachment: %w", lerr)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return nil, "", errors.New("symlinked attachments are not served")
	}

	data, rerr := os.ReadFile(cleanFinal)
	if rerr != nil {
		return nil, "", fmt.Errorf("read attachment: %w", rerr)
	}
	return data, sniffMime(filename, data), nil
}

// sniffMime is an extension-based sniffer with an http.DetectContentType
// fallback. The extension fast path covers the common attachment types
// without an allocation on the data slice.
func sniffMime(filename string, data []byte) string {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".svg":
		return "image/svg+xml"
	case ".pdf":
		return "application/pdf"
	case ".txt", ".md":
		return "text/plain; charset=utf-8"
	}
	// Fallback: DetectContentType only looks at the first 512 bytes.
	if len(data) > 512 {
		return http.DetectContentType(data[:512])
	}
	return http.DetectContentType(data)
}

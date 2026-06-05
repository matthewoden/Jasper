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

type notesProviderImpl struct {
	idx noteLister
}

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

// SearchFunc is the closure type the lifecycle root passes — it wraps
// index.SearchFTS and projects notes.SearchHit → mcp.SearchHit (the
// MCP tool's wire shape). Defined as a closure so the mcp package
// doesn't have to import internal/index (and risk a cycle).
type SearchFunc func(ctx context.Context, q string, limit int) ([]SearchHit, error)

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
	id, err := uuid.Parse(noteID)
	if err != nil {
		return nil, "", fmt.Errorf("invalid note id %q: %w", noteID, err)
	}
	summary, ok := a.notesSvc.LookupSummary(id)
	if !ok {
		return nil, "", fmt.Errorf("note not found: %s", noteID)
	}

	if strings.ContainsAny(filename, `/\`) || strings.Contains(filename, "..") {
		return nil, "", errors.New("filename must not contain path separators or '..'")
	}

	filename = filepath.Base(filepath.Clean(filename))
	if filename == "." || filename == "/" || filename == "" {
		return nil, "", errors.New("invalid filename after clean")
	}

	notesRoot := filepath.Join(a.dataDir, "notes")
	noteParentDir := filepath.Dir(filepath.Join(notesRoot, summary.Path))
	attachDir := filepath.Join(noteParentDir, "attachments")

	finalPath := filepath.Join(attachDir, filename)
	cleanFinal := filepath.Clean(finalPath)
	cleanAttach := filepath.Clean(attachDir) + string(os.PathSeparator)
	if !strings.HasPrefix(cleanFinal, cleanAttach) {
		return nil, "", errors.New("filename escapes attachments directory")
	}

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

	if len(data) > 512 {
		return http.DetectContentType(data[:512])
	}
	return http.DetectContentType(data)
}

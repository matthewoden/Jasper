package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

type secTestFixture struct {
	srv      *Server
	dataDir  string
	validID  uuid.UUID
	validRel string
}

func newSecurityTestServer(t *testing.T) secTestFixture {
	t.Helper()

	validID := uuid.New()
	validRel := "valid-note.md"
	summaries := []notes.NoteSummary{
		{
			ID:        validID,
			Path:      validRel,
			Title:     "Valid Note",
			UpdatedAt: time.Now().UTC(),
		},
	}
	srv, dataDir := newAttachmentTestServer(t, summaries)

	notesDir := filepath.Join(dataDir, "notes")
	if err := os.WriteFile(
		filepath.Join(notesDir, validRel),
		[]byte("# Valid Note\n\nSeeded by Phase 8 Plan 08-14 path-traversal suite."),
		0o644,
	); err != nil {
		t.Fatalf("seed valid-note.md: %v", err)
	}

	return secTestFixture{
		srv:      srv,
		dataDir:  dataDir,
		validID:  validID,
		validRel: validRel,
	}
}

type traversalPayload struct {
	Name    string
	Payload string
	Want4xx bool // true ⇒ MUST reject (any 4xx); false ⇒ MAY accept (well-formed input)
}

var baseTraversalPayloads = []traversalPayload{
	{Name: "dot_dot_bare", Payload: "..", Want4xx: true},
	{Name: "dot_dot_prefix", Payload: "../etc/passwd", Want4xx: true},
	{Name: "absolute_unix", Payload: "/etc/passwd", Want4xx: true},
	{Name: "windows_backslash", Payload: `\Windows\System32`, Want4xx: true},
	{Name: "url_encoded_dotdot", Payload: "..%2Fetc%2Fpasswd", Want4xx: true},
	{Name: "null_byte_in_path", Payload: "foo\x00.md", Want4xx: true},
	{Name: "empty_string", Payload: "", Want4xx: true},
	{Name: "deep_parent_escape", Payload: "../../../../etc/passwd", Want4xx: true},
}

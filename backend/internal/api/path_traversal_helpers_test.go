package api

// path_traversal_helpers_test.go — Phase 8 Plan 08-14 / SECURITY-06 / D-44.
//
// Shared helpers for TestPathTraversal_AllEndpoints (security_test.go).
//
// Goals:
//   - Build a minimal *Server with a real tmpdir dataDir + notes/ pre-created.
//   - Seed a known-good note so "valid" cases can succeed.
//   - Provide is4xx / is2xx helpers that work across the response-object
//     types emitted by oapi-codegen's strict-server target.
//
// Why a separate file: keeps security_test.go focused on the table of
// (endpoint, payload) cases without 200 lines of fixture boilerplate.
//
// Notes:
//   - We re-use newAttachmentTestServer (attachments_handler_test.go) as the
//     core fixture because it already wires Server.dataDir + a fake index
//     + the notes.Service. The only thing we add here is seeding a known
//     valid note and a uniform is4xx / is2xx classifier.

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// secTestFixture bundles the *Server with the dataDir + the UUID of a
// seeded "valid" note (so endpoints that key on noteID — e.g. attachment
// upload — have a stable target). The "valid" note lives at notes/valid-note.md.
type secTestFixture struct {
	srv      *Server
	dataDir  string
	validID  uuid.UUID
	validRel string // "valid-note.md"
}

// newSecurityTestServer constructs the consolidated test fixture used by
// TestPathTraversal_AllEndpoints. It seeds a single valid note on disk +
// in the fake index so the "acceptable shape" subtest can succeed and the
// suite proves both directions of the contract (reject-bad / accept-good).
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

	// Write the on-disk file so reveal / files / notes-by-path can resolve it.
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

// traversalPayloads is the locked payload table reused across every endpoint
// subtest in TestPathTraversal_AllEndpoints. The "want4xx" column marks which
// payloads MUST refuse on every endpoint. Endpoint-specific subtests may
// extend this with their own acceptable-shape rows (e.g. CreateFile's
// "valid sub-dir is empty string" case).
//
// The eight rejection shapes mirror the 5-rule pipeline declared in
// backend/internal/api/files.go and the reveal-handler resolveRevealPath.
type traversalPayload struct {
	Name    string
	Payload string
	Want4xx bool // true ⇒ MUST reject (any 4xx); false ⇒ MAY accept (well-formed input)
}

// baseTraversalPayloads is the canonical 8-row table — bad inputs every
// endpoint MUST reject. Endpoint subtests append their own "happy" rows.
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

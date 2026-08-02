package mcp_test

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/mcp"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// The vault-escape guarantee held for notes but failed for attachments:
// read_attachment ran its own leaf-only os.Lstat, blind to a symlink on an
// intermediate directory. The AI cannot plant one itself — MCP writes go
// through fsstore — but a user's own notes/shared -> /external would do.
func TestReadAttachment_RejectsSymlinkedAncestor(t *testing.T) {
	t.Parallel()

	adapter, noteID := newSymlinkedAttachmentAdapter(t)

	data, _, err := adapter.Read(context.Background(), noteID, "secret.png")
	if err == nil {
		t.Fatalf("read_attachment read %d bytes from outside the vault through a symlinked parent: %q",
			len(data), string(data))
	}
}

// newSymlinkedAttachmentAdapter wires an adapter over a vault whose notes/
// contains a symlink out of the vault, with a note registered behind it — so
// the derived attachments directory resolves outside.
func newSymlinkedAttachmentAdapter(t *testing.T) (mcp.AttachmentProvider, string) {
	t.Helper()

	dataDir := t.TempDir()
	notesDir := filepath.Join(dataDir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}

	external := t.TempDir()
	if err := os.MkdirAll(filepath.Join(external, "attachments"), 0o700); err != nil {
		t.Fatalf("mkdir external attachments: %v", err)
	}
	secret := filepath.Join(external, "attachments", "secret.png")
	if err := os.WriteFile(secret, []byte("outside the vault"), 0o600); err != nil {
		t.Fatalf("write external attachment: %v", err)
	}

	if err := os.Symlink(external, filepath.Join(notesDir, "shared")); err != nil {
		t.Skipf("symlinks not supported on this platform: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := notes.NewService(fsstore.NewStore(notesDir), nil, nil, logger)

	// Register a note living behind the link, which is what puts the derived
	// attachments directory outside the vault.
	noteID := uuid.New()
	svc.Registry().AddRecord(noteID, "shared/note.md", "note")

	return mcp.NewAttachmentAdapter(svc, dataDir), noteID.String()
}

// TestReadAttachment_RevealsNothingAboutFilesOutsideTheVault: the rejection
// must not distinguish an existing file from a missing one, or the AI gains an
// existence probe for arbitrary paths outside the vault.
func TestReadAttachment_RevealsNothingAboutFilesOutsideTheVault(t *testing.T) {
	t.Parallel()

	adapter, noteID := newSymlinkedAttachmentAdapter(t)

	_, _, existingErr := adapter.Read(context.Background(), noteID, "secret.png")
	_, _, missingErr := adapter.Read(context.Background(), noteID, "nope.png")

	if existingErr == nil || missingErr == nil {
		t.Fatalf("both reads must fail; got existing=%v missing=%v", existingErr, missingErr)
	}
	if existingErr.Error() != missingErr.Error() {
		t.Errorf("escaped paths must be indistinguishable:\n  existing: %v\n  missing:  %v",
			existingErr, missingErr)
	}
}

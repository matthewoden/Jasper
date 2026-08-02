package api

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// newSymlinkEscapeVault builds a vault whose notes/ holds a symlinked directory
// pointing outside it — `notes/shared -> /external/docs`, a common Obsidian
// habit. This is why a leaf-only os.Lstat is not enough: Lstat on
// notes/shared/secret.txt reports an ordinary file, because the symlink is on
// an intermediate component.
func newSymlinkEscapeVault(t *testing.T, summaries []notes.NoteSummary) (*Server, string, string) {
	t.Helper()

	srv, dataDir := newAttachmentTestServer(t, summaries)

	external := t.TempDir()
	if err := os.WriteFile(filepath.Join(external, "secret.txt"), []byte("exfiltrate me"), 0o600); err != nil {
		t.Fatalf("write secret.txt: %v", err)
	}

	link := filepath.Join(dataDir, "notes", "shared")
	if err := os.Symlink(external, link); err != nil {
		t.Fatalf("symlink %s -> %s: %v", link, external, err)
	}

	// Guard the premise: without containment the read genuinely succeeds.
	if _, err := os.ReadFile(filepath.Join(link, "secret.txt")); err != nil {
		t.Fatalf("test setup: expected the symlinked path to be readable on this platform: %v", err)
	}

	return srv, dataDir, external
}

// TestGetFile_RejectsSymlinkedAncestor covers GET /api/v1/files.
func TestGetFile_RejectsSymlinkedAncestor(t *testing.T) {
	t.Parallel()
	srv, _, _ := newSymlinkEscapeVault(t, nil)

	got := callGetFile(t, srv, "shared/secret.txt")
	if got.status == http.StatusOK {
		t.Fatalf("GET /files read a file outside the vault through a symlinked parent: %q", got.body)
	}
	expectFileError(t, got, "shared/secret.txt", http.StatusBadRequest, "invalid_path")
}

// TestServeFile_RejectsSymlinkedAncestor covers the hand-mounted ServeFile,
// which is the handler a browser actually reaches (it is registered after
// HandlerFromMux so chi's last-registration-wins promotes it over the
// generated GetFile wrapper).
func TestServeFile_RejectsSymlinkedAncestor(t *testing.T) {
	t.Parallel()
	srv, _, _ := newSymlinkEscapeVault(t, nil)

	rec, body := callServeFile(t, srv, "shared/secret.txt")
	if rec.Code == 200 {
		t.Fatalf("ServeFile read a file outside the vault through a symlinked parent: body=%q", body)
	}
	if rec.Code != 400 {
		t.Errorf("status: got %d, want 400", rec.Code)
	}
}

// TestDeleteFile_RejectsSymlinkedAncestor covers the shared resolver used by
// DeleteFile and PostFileMove — a delete through the link would destroy a
// file outside the vault.
func TestDeleteFile_RejectsSymlinkedAncestor(t *testing.T) {
	t.Parallel()
	srv, _, external := newSymlinkEscapeVault(t, nil)

	resp, err := srv.DeleteFile(context.Background(), DeleteFileRequestObject{
		Params: DeleteFileParams{Path: "shared/secret.txt"},
	})
	if err != nil {
		t.Fatalf("DeleteFile error: %v", err)
	}
	if _, deleted := resp.(DeleteFile204Response); deleted {
		t.Fatal("DELETE /files removed a file outside the vault through a symlinked parent")
	}
	if _, statErr := os.Stat(filepath.Join(external, "secret.txt")); statErr != nil {
		t.Errorf("external file was removed: %v", statErr)
	}
}

// TestCreateFile_RejectsSymlinkedAncestor covers the write direction: an
// upload whose target directory sits behind the link would write attacker
// bytes outside the vault.
func TestCreateFile_RejectsSymlinkedAncestor(t *testing.T) {
	t.Parallel()
	srv, _, external := newSymlinkEscapeVault(t, nil)

	// One level BELOW the link. Targeting "shared" directly is already caught,
	// because there the symlink is the leaf that os.Lstat inspects — which is
	// precisely why the leaf-only check reads as sufficient until you go a
	// single directory deeper.
	if err := os.MkdirAll(filepath.Join(external, "sub"), 0o700); err != nil {
		t.Fatalf("mkdir external sub: %v", err)
	}

	resp, err := srv.CreateFile(context.Background(), CreateFileRequestObject{
		Params: CreateFileParams{Path: "shared/sub"},
		Body:   buildMultipartRequest(t, "planted.png", []byte("bytes")),
	})
	if err == nil {
		if _, created := resp.(CreateFile201JSONResponse); created {
			t.Fatal("POST /files wrote outside the vault through a symlinked ancestor dir")
		}
	}
	if _, statErr := os.Stat(filepath.Join(external, "sub", "planted.png")); !os.IsNotExist(statErr) {
		t.Errorf("upload landed outside the vault (stat err: %v)", statErr)
	}
}

// TestGetAttachment_RejectsSymlinkedAncestor covers GET /api/v1/attachments.
// The attachments dir is derived from the note's own path, so a note recorded
// under the symlinked directory puts the whole attachment lookup outside the
// vault.
func TestGetAttachment_RejectsSymlinkedAncestor(t *testing.T) {
	t.Parallel()

	noteID := uuid.New()
	srv, _, external := newSymlinkEscapeVault(t, []notes.NoteSummary{{
		ID:        noteID,
		Path:      "shared/note.md",
		Title:     "Note behind the link",
		UpdatedAt: time.Now().UTC(),
	}})

	attachDir := filepath.Join(external, "attachments")
	if err := os.MkdirAll(attachDir, 0o700); err != nil {
		t.Fatalf("mkdir external attachments: %v", err)
	}
	if err := os.WriteFile(filepath.Join(attachDir, "secret.png"), []byte("outside"), 0o600); err != nil {
		t.Fatalf("write external attachment: %v", err)
	}

	resp, err := srv.GetAttachment(context.Background(), GetAttachmentRequestObject{
		NoteId:   noteID.String(),
		Filename: "secret.png",
	})
	if err != nil {
		t.Fatalf("GetAttachment error: %v", err)
	}
	if _, leaked := resp.(GetAttachment200ApplicationoctetStreamResponse); leaked {
		t.Fatal("GET /attachments read a file outside the vault through a symlinked parent directory")
	}
}

// Containment must be decided BEFORE the leaf is stat'ed. Checking the leaf
// first is tempting (it preserves the 403 symlink_rejected), but then 400-vs-404
// distinguishes an existing file behind a symlinked ancestor from a missing one
// — an existence probe for arbitrary paths outside the vault.
func TestContainment_RevealsNothingAboutFilesOutsideTheVault(t *testing.T) {
	t.Parallel()
	srv, _, _ := newSymlinkEscapeVault(t, nil)

	existing := callGetFile(t, srv, "shared/secret.txt") // exists outside the vault
	missing := callGetFile(t, srv, "shared/nope.txt")    // does not exist

	if existing.status != missing.status || existing.code != missing.code {
		t.Errorf("escaped paths must be indistinguishable: existing gave %d/%q, missing gave %d/%q",
			existing.status, existing.code, missing.status, missing.code)
	}
}

// TestCreateAttachment_RejectsSymlinkedAncestor covers the attachment write
// direction. The attachments directory is derived from the note's path, so a
// note behind the link would have its uploads land outside the vault.
func TestCreateAttachment_RejectsSymlinkedAncestor(t *testing.T) {
	t.Parallel()

	noteID := uuid.New()
	srv, _, external := newSymlinkEscapeVault(t, []notes.NoteSummary{{
		ID:        noteID,
		Path:      "shared/note.md",
		Title:     "Note behind the link",
		UpdatedAt: time.Now().UTC(),
	}})

	resp, err := srv.CreateAttachment(context.Background(), CreateAttachmentRequestObject{
		NoteId: noteID.String(),
		Body:   buildMultipartRequest(t, "planted.png", []byte("bytes")),
	})
	if err == nil {
		if _, created := resp.(CreateAttachment200JSONResponse); created {
			t.Fatal("POST /attachments wrote outside the vault through a symlinked parent directory")
		}
	}
	if _, statErr := os.Stat(filepath.Join(external, "attachments", "planted.png")); !os.IsNotExist(statErr) {
		t.Errorf("upload landed outside the vault (stat err: %v)", statErr)
	}
}

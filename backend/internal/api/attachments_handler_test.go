package api

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"mime/multipart"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

type fakeIndexForAttachments struct {
	summaries []notes.NoteSummary
}

var _ notes.Index = (*fakeIndexForAttachments)(nil)

func (f *fakeIndexForAttachments) Upsert(_ context.Context, _ notes.NoteRecord) error { return nil }
func (f *fakeIndexForAttachments) Delete(_ context.Context, _ uuid.UUID) error        { return nil }
func (f *fakeIndexForAttachments) List(_ context.Context) ([]notes.NoteSummary, error) {
	return f.summaries, nil
}

func (f *fakeIndexForAttachments) LookupByPath(_ context.Context, _ string) (notes.NoteRecord, error) {
	return notes.NoteRecord{}, notes.ErrNotFound
}

func (f *fakeIndexForAttachments) MovePathPrefix(_ context.Context, _, _ string) (int, error) {
	return 0, nil
}

func (f *fakeIndexForAttachments) DeleteByPathPrefix(_ context.Context, _ string) (int, error) {
	return 0, nil
}

func (f *fakeIndexForAttachments) ListTags(_ context.Context) ([]notes.TagWithCount, error) {
	return nil, nil
}

func (f *fakeIndexForAttachments) SyncTags(_ context.Context, _ uuid.UUID, _ []string) error {
	return nil
}

func (f *fakeIndexForAttachments) SyncBacklinks(_ context.Context, _ uuid.UUID, _ string,
	_ []markdown.WikiLinkRef, _ *notes.Registry, _ []byte,
) error {
	return nil
}

func (f *fakeIndexForAttachments) NotesByTag(_ context.Context, _ string) ([]notes.NoteSummary, error) {
	return nil, nil
}

func (f *fakeIndexForAttachments) RenameTag(_ context.Context, _, _ string) ([]uuid.UUID, error) {
	return nil, nil
}

func (f *fakeIndexForAttachments) DeleteTag(_ context.Context, _ string) ([]uuid.UUID, error) {
	return nil, nil
}

func (f *fakeIndexForAttachments) SourcesByBacklinkTitle(_ context.Context, _ string) ([]notes.NoteSummary, error) {
	return nil, nil
}

func (f *fakeIndexForAttachments) UpdateBacklinksTargetTitle(_ context.Context, _, _ string, _ *uuid.UUID) error {
	return nil
}

func (f *fakeIndexForAttachments) GetBacklinks(_ context.Context, _ uuid.UUID) ([]notes.BacklinkRow, error) {
	return nil, nil
}

func (f *fakeIndexForAttachments) SearchTitles(_ context.Context, _ string, _ int) ([]notes.SearchResult, error) {
	return nil, nil
}

func (f *fakeIndexForAttachments) SearchFTS(_ context.Context, _ string, _ []string, _ int) ([]notes.SearchHit, error) {
	return nil, nil
}

func newAttachmentTestServer(t *testing.T, summaries []notes.NoteSummary) (*Server, string) {
	t.Helper()
	dir := t.TempDir()

	notesDir := filepath.Join(dir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idx := &fakeIndexForAttachments{summaries: summaries}
	svc := notes.NewService(&fakeFileStore{}, idx, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, nil, logger, dir)
	return srv, dir
}

func buildMultipartRequest(t *testing.T, filename string, data []byte) *multipart.Reader {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	return multipart.NewReader(&buf, mw.Boundary())
}

func callCreateAttachment(
	t *testing.T,
	srv *Server,
	noteID string,
	filename string,
	data []byte,
) CreateAttachmentResponseObject {
	t.Helper()
	mr := buildMultipartRequest(t, filename, data)
	resp, err := srv.CreateAttachment(context.Background(), CreateAttachmentRequestObject{
		NoteId: noteID,
		Body:   mr,
	})
	if err != nil {
		t.Fatalf("CreateAttachment error: %v", err)
	}
	return resp
}

// TestAttachmentsUploadStorage verifies storage-layout rules:
//   - Root-level note  → notes/attachments/
//   - Sub-folder note  → notes/sub/attachments/
//   - Oversize upload  → 413
func TestAttachmentsUploadStorage(t *testing.T) {
	t.Parallel()

	pngHeader := []byte("\x89PNG\r\n\x1a\n")

	rootID := uuid.New()
	nestedID := uuid.New()
	summaries := []notes.NoteSummary{
		{ID: rootID, Path: "root.md", Title: "Root", UpdatedAt: time.Now()},
		{ID: nestedID, Path: "sub/nested.md", Title: "Nested", UpdatedAt: time.Now()},
	}
	srv, dataDir := newAttachmentTestServer(t, summaries)

	t.Run("root note uploads to notes/attachments/", func(t *testing.T) {
		resp := callCreateAttachment(t, srv, rootID.String(), "hello.png", pngHeader)

		got200, ok := resp.(CreateAttachment200JSONResponse)
		if !ok {
			t.Fatalf("expected CreateAttachment200JSONResponse, got %T", resp)
		}
		if got200.Filename != "hello.png" {
			t.Errorf("filename: got %q, want %q", got200.Filename, "hello.png")
		}
		if got200.Path != "attachments/hello.png" {
			t.Errorf("path: got %q, want %q", got200.Path, "attachments/hello.png")
		}
		if !got200.IsImage {
			t.Error("is_image: expected true for PNG")
		}
		if got200.Category != Image {
			t.Errorf("category: got %q, want %q", got200.Category, Image)
		}

		want := filepath.Join(dataDir, "notes", "attachments", "hello.png")
		if _, err := os.Stat(want); err != nil {
			t.Errorf("file not found at expected path %q: %v", want, err)
		}
	})

	t.Run("sub-folder note uploads to notes/sub/attachments/", func(t *testing.T) {
		resp := callCreateAttachment(t, srv, nestedID.String(), "doc.png", pngHeader)

		got200, ok := resp.(CreateAttachment200JSONResponse)
		if !ok {
			t.Fatalf("expected CreateAttachment200JSONResponse, got %T", resp)
		}
		if got200.Path != "attachments/doc.png" {
			t.Errorf("path: got %q, want %q", got200.Path, "attachments/doc.png")
		}

		want := filepath.Join(dataDir, "notes", "sub", "attachments", "doc.png")
		if _, err := os.Stat(want); err != nil {
			t.Errorf("file not found at %q: %v", want, err)
		}
		wrong := filepath.Join(dataDir, "notes", "attachments", "doc.png")
		if _, err := os.Stat(wrong); err == nil {
			t.Error("file should NOT be in notes/attachments/ for a sub-folder note")
		}
	})

	t.Run("oversize upload returns 413", func(t *testing.T) {
		big := make([]byte, maxAttachmentBytes+1)
		resp := callCreateAttachment(t, srv, rootID.String(), "huge.bin", big)

		got413, ok := resp.(CreateAttachment413JSONResponse)
		if !ok {
			t.Fatalf("expected CreateAttachment413JSONResponse, got %T", resp)
		}
		if got413.Code != "file_too_large" {
			t.Errorf("code: got %q, want %q", got413.Code, "file_too_large")
		}
	})
}

// TestUniqueAttachmentName verifies collision auto-rename logic.
func TestUniqueAttachmentName(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	if got := generateUniqueFilename(dir, "image.png"); got != "image.png" {
		t.Errorf("no collision: got %q, want %q", got, "image.png")
	}

	if err := os.WriteFile(filepath.Join(dir, "image.png"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := generateUniqueFilename(dir, "image.png"); got != "image-1.png" {
		t.Errorf("one collision: got %q, want %q", got, "image-1.png")
	}

	if err := os.WriteFile(filepath.Join(dir, "image-1.png"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := generateUniqueFilename(dir, "image.png"); got != "image-2.png" {
		t.Errorf("two collisions: got %q, want %q", got, "image-2.png")
	}

	if got := generateUniqueFilename(dir, "README"); got != "README" {
		t.Errorf("no-ext first: got %q, want %q", got, "README")
	}
	if err := os.WriteFile(filepath.Join(dir, "README"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := generateUniqueFilename(dir, "README"); got != "README-1" {
		t.Errorf("no-ext collision: got %q, want %q", got, "README-1")
	}
}

// TestAttachmentsSecurity exercises the 5-rule path-traversal hardening on
// GetAttachment.
func TestAttachmentsSecurity(t *testing.T) {
	t.Parallel()

	noteID := uuid.New()
	summaries := []notes.NoteSummary{
		{ID: noteID, Path: "test.md", Title: "Test", UpdatedAt: time.Now()},
	}
	srv, dataDir := newAttachmentTestServer(t, summaries)

	attachDir := filepath.Join(dataDir, "notes", "attachments")
	if err := os.MkdirAll(attachDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	realFile := filepath.Join(attachDir, "real.txt")
	if err := os.WriteFile(realFile, []byte("content"), 0o644); err != nil {
		t.Fatalf("write real file: %v", err)
	}

	t.Run("path separators rejected (rule 1)", func(t *testing.T) {
		badNames := []string{
			"../etc/passwd",
			"sub/file.png",
			`..\windows\system32`,
			"..",
			"a/b",
		}
		for _, bad := range badNames {
			resp, err := srv.GetAttachment(context.Background(), GetAttachmentRequestObject{
				NoteId:   noteID.String(),
				Filename: bad,
			})
			if err != nil {
				t.Errorf("name=%q: unexpected error: %v", bad, err)
				continue
			}
			if _, ok := resp.(GetAttachment400JSONResponse); !ok {
				t.Errorf("name=%q: expected GetAttachment400JSONResponse, got %T", bad, resp)
			}
		}
	})

	t.Run("symlink rejected (rule 5)", func(t *testing.T) {
		outside := filepath.Join(t.TempDir(), "secret.txt")
		if err := os.WriteFile(outside, []byte("secret data"), 0o600); err != nil {
			t.Fatalf("write outside file: %v", err)
		}

		symlinkPath := filepath.Join(attachDir, "evil.txt")
		if err := os.Symlink(outside, symlinkPath); err != nil {
			t.Skipf("symlinks not supported on this platform: %v", err)
		}
		t.Cleanup(func() { _ = os.Remove(symlinkPath) })

		resp, err := srv.GetAttachment(context.Background(), GetAttachmentRequestObject{
			NoteId:   noteID.String(),
			Filename: "evil.txt",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		got403, ok := resp.(GetAttachment403JSONResponse)
		if !ok {
			t.Fatalf("expected GetAttachment403JSONResponse, got %T", resp)
		}
		if got403.Code != "symlink_rejected" {
			t.Errorf("code: got %q, want %q", got403.Code, "symlink_rejected")
		}
	})

	t.Run("missing file returns 404", func(t *testing.T) {
		resp, err := srv.GetAttachment(context.Background(), GetAttachmentRequestObject{
			NoteId:   noteID.String(),
			Filename: "does-not-exist.txt",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if _, ok := resp.(GetAttachment404JSONResponse); !ok {
			t.Fatalf("expected GetAttachment404JSONResponse, got %T", resp)
		}
	})

	t.Run("existing file streams successfully", func(t *testing.T) {
		resp, err := srv.GetAttachment(context.Background(), GetAttachmentRequestObject{
			NoteId:   noteID.String(),
			Filename: "real.txt",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		got200, ok := resp.(GetAttachment200ApplicationoctetStreamResponse)
		if !ok {
			t.Fatalf("expected GetAttachment200ApplicationoctetStreamResponse, got %T", resp)
		}
		body, err := io.ReadAll(got200.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		if string(body) != "content" {
			t.Errorf("body: got %q, want %q", body, "content")
		}
		if got200.ContentLength != int64(len("content")) {
			t.Errorf("ContentLength: got %d, want %d", got200.ContentLength, len("content"))
		}
	})

	t.Run("unknown noteId returns 404", func(t *testing.T) {
		resp, err := srv.GetAttachment(context.Background(), GetAttachmentRequestObject{
			NoteId:   uuid.New().String(),
			Filename: "real.txt",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if _, ok := resp.(GetAttachment404JSONResponse); !ok {
			t.Fatalf("expected GetAttachment404JSONResponse, got %T", resp)
		}
	})
}

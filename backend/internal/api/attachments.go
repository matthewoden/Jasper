package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

const maxAttachmentBytes int64 = 100 << 20

// attachmentsRelDir returns the vault-relative attachments directory for a
// note — <note's parent>/attachments. Kept as a relative path so it can be
// containment-checked against notes/ as a whole; resolving it to an
// absolute path first would discard the ancestor components that need checking.
func attachmentsRelDir(notePath string) string {
	return filepath.Join(filepath.Dir(notePath), "attachments")
}

// CreateAttachment implements POST /api/v1/attachments/{noteId}.
//
// Accepts multipart/form-data with a single field 'file'. Stores the file under
// <dataDir>/notes/<parent>/attachments/. Auto-renames on collision
// (image.png → image-1.png). Enforces 100 MB cap. Returns AttachmentUploadResult
// with filename, path, content_type, category, is_image, size_bytes.
//
//nolint:revive // generated interface name
func (s *Server) CreateAttachment(
	ctx context.Context,
	req CreateAttachmentRequestObject,
) (CreateAttachmentResponseObject, error) {
	note, err := s.lookupNoteByStringID(ctx, req.NoteId)
	if err != nil {
		return CreateAttachment404JSONResponse(newError("not_found", "note not found")), nil
	}

	if req.Body == nil {
		return CreateAttachment404JSONResponse(newError("invalid_request", "missing multipart body")), nil
	}

	part, err := req.Body.NextPart()
	if err != nil {
		s.log.Error("CreateAttachment: read multipart part", "noteId", req.NoteId, "err", err)
		return CreateAttachment404JSONResponse(newError("invalid_request", "missing multipart 'file' part")), nil
	}
	defer part.Close() //nolint:errcheck

	if part.FormName() != "file" {
		return CreateAttachment404JSONResponse(newError("invalid_request", "expected form field named 'file'")), nil
	}

	capped := io.LimitReader(part, maxAttachmentBytes+1)
	data, readErr := io.ReadAll(capped)
	if readErr != nil {
		s.log.Error("CreateAttachment: io.ReadAll", "noteId", req.NoteId, "err", readErr)
		return nil, errors.New("read upload failed")
	}
	if int64(len(data)) > maxAttachmentBytes {
		return CreateAttachment413JSONResponse(newError("file_too_large", "Maximum upload size is 100 MB.")), nil
	}

	originalFilename := part.FileName()
	if originalFilename == "" {
		return CreateAttachment404JSONResponse(newError("invalid_request", "upload part missing filename")), nil
	}

	originalFilename = filepath.Base(filepath.Clean(originalFilename))
	if originalFilename == "." || originalFilename == "/" || originalFilename == "" {
		return CreateAttachment404JSONResponse(newError("invalid_request", "invalid upload filename")), nil
	}

	// Contain the whole vault-relative attachments path, not just the
	// filename: the directory is derived from the note's own path, so a
	// symlinked ancestor anywhere in that chain would put the write outside
	// the vault.
	attachDir, containErr := s.containedUnderNotes(attachmentsRelDir(note.Path))
	if containErr != nil {
		s.log.Error("CreateAttachment: containment", "notePath", note.Path, "err", containErr)
		return CreateAttachment404JSONResponse(newError("invalid_path",
			"attachments directory escapes the notes directory")), nil
	}
	if mkErr := os.MkdirAll(attachDir, 0o755); mkErr != nil {
		s.log.Error("CreateAttachment: MkdirAll", "dir", attachDir, "err", mkErr)
		return nil, fmt.Errorf("create attachments dir: %w", mkErr)
	}

	finalName := generateUniqueFilename(attachDir, originalFilename)
	absPath := filepath.Join(attachDir, finalName)

	if writeErr := fsstore.AtomicWrite(absPath, data); writeErr != nil {
		s.log.Error("CreateAttachment: AtomicWrite", "path", absPath, "err", writeErr)
		return nil, fmt.Errorf("write attachment: %w", writeErr)
	}

	sniffEnd := 512
	if len(data) < sniffEnd {
		sniffEnd = len(data)
	}
	contentType := http.DetectContentType(data[:sniffEnd])

	if contentType == "application/octet-stream" {
		switch strings.ToLower(filepath.Ext(finalName)) {
		case ".pdf":
			contentType = "application/pdf"
		case ".zip":
			contentType = "application/zip"
		case ".tar":
			contentType = "application/x-tar"
		case ".gz":
			contentType = "application/x-gzip"
		case ".mp4":
			contentType = "video/mp4"
		case ".mp3":
			contentType = "audio/mpeg"
		case ".wav":
			contentType = "audio/wav"
		}
	}
	category := mimeToCategory(contentType, filepath.Ext(finalName))
	isImage := strings.HasPrefix(contentType, "image/")

	if s.broadcaster != nil {
		notesRoot := filepath.Join(s.dataDir, "notes")
		attachRelPath, relErr := filepath.Rel(notesRoot, absPath)
		if relErr != nil {
			attachRelPath = "attachments/" + finalName
		}
		s.broadcaster.Broadcast(notes.EventFileCreated, map[string]any{
			"path": filepath.ToSlash(attachRelPath),
			"name": finalName,
		}, notes.SessionIDFromContext(ctx))
	}

	return CreateAttachment200JSONResponse{
		Filename:    finalName,
		Path:        "attachments/" + finalName,
		ContentType: contentType,
		Category:    AttachmentUploadResultCategory(category),
		IsImage:     isImage,
		SizeBytes:   int64(len(data)),
	}, nil
}

// GetAttachment implements GET /api/v1/attachments/{noteId}/{filename}.
//
// The generated response type hard-codes application/octet-stream and offers no
// way to set a real MIME type, so the client sniffs from the filename instead.
//
//nolint:revive // generated interface name
func (s *Server) GetAttachment(
	ctx context.Context,
	req GetAttachmentRequestObject,
) (GetAttachmentResponseObject, error) {
	note, err := s.lookupNoteByStringID(ctx, req.NoteId)
	if err != nil {
		return GetAttachment404JSONResponse(newError("not_found", "note not found")), nil
	}

	filename := req.Filename

	if strings.ContainsAny(filename, `/\`) || strings.Contains(filename, "..") {
		return GetAttachment400JSONResponse(newError("invalid_filename",
			"filename must not contain path separators or '..'")), nil
	}

	filename = filepath.Base(filepath.Clean(filename))
	if filename == "." || filename == "/" || filename == "" {
		return GetAttachment400JSONResponse(newError("invalid_filename", "invalid filename after clean")), nil
	}

	attachRel := filepath.Join(attachmentsRelDir(note.Path), filename)

	cleanFinal, _, resolveErr := fsstore.ResolveContained(s.notesRoot(), attachRel)
	switch {
	case resolveErr == nil:
	case errors.Is(resolveErr, fsstore.ErrSymlinkLeaf):
		return GetAttachment403JSONResponse(newError("symlink_rejected",
			"symlinked attachments are not served")), nil
	case os.IsNotExist(resolveErr):
		return GetAttachment404JSONResponse(newError("not_found", "attachment not found")), nil
	case errors.Is(resolveErr, fsstore.ErrNotInRoot), errors.Is(resolveErr, fsstore.ErrPathEscape),
		errors.Is(resolveErr, fsstore.ErrAbsolutePath), errors.Is(resolveErr, fsstore.ErrEmptyPath):
		return GetAttachment400JSONResponse(newError("invalid_path",
			"attachment path escapes the notes directory")), nil
	default:
		s.log.Error("GetAttachment: resolve", "path", attachRel, "err", resolveErr)
		return nil, errors.New("could not read attachment")
	}

	fileData, readErr := os.ReadFile(cleanFinal)
	if readErr != nil {
		s.log.Error("GetAttachment: ReadFile", "path", cleanFinal, "err", readErr)
		return nil, errors.New("could not read attachment")
	}

	return GetAttachment200ApplicationoctetStreamResponse{
		Body:          bytes.NewReader(fileData),
		ContentLength: int64(len(fileData)),
	}, nil
}

func (s *Server) lookupNoteByStringID(ctx context.Context, noteID string) (notes.NoteSummary, error) {
	if s.index == nil {
		return notes.NoteSummary{}, errors.New("no index")
	}

	id, err := uuid.Parse(noteID)
	if err != nil {
		return notes.NoteSummary{}, fmt.Errorf("invalid note id: %w", err)
	}

	summaries, listErr := s.index.List(ctx)
	if listErr != nil {
		return notes.NoteSummary{}, fmt.Errorf("list notes: %w", listErr)
	}

	for _, sm := range summaries {
		if sm.ID == id {
			return sm, nil
		}
	}
	return notes.NoteSummary{}, notes.ErrNotFound
}

func generateUniqueFilename(dir, filename string) string {
	ext := filepath.Ext(filename)
	base := strings.TrimSuffix(filename, ext)

	if _, err := os.Stat(filepath.Join(dir, filename)); os.IsNotExist(err) {
		return filename
	}

	for i := 1; i < 1000; i++ {
		candidate := fmt.Sprintf("%s-%d%s", base, i, ext)
		if _, err := os.Stat(filepath.Join(dir, candidate)); os.IsNotExist(err) {
			return candidate
		}
	}

	return fmt.Sprintf("%s-%d%s", base, 999, ext)
}

func mimeToCategory(mimeType, _ string) string {
	switch {
	case strings.HasPrefix(mimeType, "image/"):
		return "image"
	case strings.HasPrefix(mimeType, "video/"):
		return "video"
	case strings.HasPrefix(mimeType, "audio/"):
		return "audio"
	case mimeType == "application/pdf":
		return "pdf"
	case mimeType == "application/zip",
		mimeType == "application/x-tar",
		mimeType == "application/x-gzip",
		strings.Contains(mimeType, "compressed"):
		return "archive"
	default:
		return "other"
	}
}

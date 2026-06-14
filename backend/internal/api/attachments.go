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

	notesRoot := filepath.Join(s.dataDir, "notes")
	noteParentDir := filepath.Dir(filepath.Join(notesRoot, note.Path))
	attachDir := filepath.Join(noteParentDir, "attachments")
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
// Streams the attachment file with full path-traversal hardening (5-rule pipeline).
//
// Note on Content-Type: oapi-codegen's GetAttachment200ApplicationoctetStreamResponse
// always sets Content-Type: application/octet-stream in VisitGetAttachmentResponse.
// The actual MIME type is not settable via the generated response struct; the frontend
// must sniff the type from the filename or re-request after knowing the category from
// the CreateAttachment response. This is a known v1 limitation.
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

	notesRoot := filepath.Join(s.dataDir, "notes")
	noteParentDir := filepath.Dir(filepath.Join(notesRoot, note.Path))
	attachDir := filepath.Join(noteParentDir, "attachments")

	finalPath := filepath.Join(attachDir, filename)
	cleanFinal := filepath.Clean(finalPath)
	cleanAttach := filepath.Clean(attachDir) + string(os.PathSeparator)
	if !strings.HasPrefix(cleanFinal, cleanAttach) {
		return GetAttachment400JSONResponse(newError("invalid_path",
			"filename escapes attachments directory")), nil
	}

	fi, lstatErr := os.Lstat(cleanFinal)
	if lstatErr != nil {
		if os.IsNotExist(lstatErr) {
			return GetAttachment404JSONResponse(newError("not_found", "attachment not found")), nil
		}
		s.log.Error("GetAttachment: Lstat", "path", cleanFinal, "err", lstatErr)
		return nil, errors.New("could not read attachment")
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return GetAttachment403JSONResponse(newError("symlink_rejected",
			"symlinked attachments are not served")), nil
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

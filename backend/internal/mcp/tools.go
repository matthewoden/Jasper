// Phase 8 Plan 08-09 (D-16 / D-21 / D-56 / D-57): MCP tool registrations.
//
// Tool surface (D-16):
//
//	read tools (no ACL check):
//	  - list_notes
//	  - read_note
//	  - search_notes
//	  - read_attachment
//	tier-1 write tools (acl.CanCreate / CanUpdate):
//	  - create_note
//	  - update_note
//	tier-2 write tools (acl.CanMove / CanDelete):
//	  - move_note
//	  - delete_note
//
// Every write tool:
//  1. Runs the ACL check BEFORE invoking notes.Service.
//  2. On denial, returns an MCP error containing "no_grant".
//  3. On success, logs `mcp.write tool=<name> path=<path> level=<int>`
//     per D-21.
//
// notes.Service emits the matching note:* WS event itself (D-57), so the
// MCP layer never broadcasts directly.

package mcp

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// ---------- Argument / result shapes (D-16) ----------

// ListNotesArgs — list_notes takes no arguments.
type ListNotesArgs struct{}

// NoteRef is the lightweight projection returned by list_notes /
// search_notes — id + path + title is enough for an AI client to pick a
// target for a follow-up read_note / update_note call.
type NoteRef struct {
	ID    string `json:"id"`
	Path  string `json:"path"`
	Title string `json:"title"`
}

// ListNotesResult is the list_notes result envelope.
type ListNotesResult struct {
	Notes []NoteRef `json:"notes"`
}

// ReadNoteArgs accepts EITHER id OR path; id wins if both are set.
type ReadNoteArgs struct {
	ID   string `json:"id,omitempty" jsonschema:"note UUID (preferred for rename resilience)"`
	Path string `json:"path,omitempty" jsonschema:"notes/-relative path (fallback if id unknown)"`
}

// ReadNoteResult — read_note returns the full note body + metadata.
// UpdatedAt is RFC3339Nano so the AI can echo it back as the
// If-Match argument on a follow-up update_note.
type ReadNoteResult struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	UpdatedAt string `json:"updated_at"`
}

// SearchNotesArgs — search_notes takes an FTS5 query + optional limit.
type SearchNotesArgs struct {
	Query string `json:"query" jsonschema:"FTS5 query string"`
	Limit int    `json:"limit,omitempty" jsonschema:"max results (default 20, cap 100)"`
}

// SearchHit is one row of an FTS5 result. ExcerptHTML carries the
// <mark>...</mark> snippet that the index produces (T-7-08 mitigation:
// the index escapes user content; only the <mark> tags are unescaped).
type SearchHit struct {
	ID          string `json:"id"`
	Path        string `json:"path"`
	Title       string `json:"title"`
	ExcerptHTML string `json:"excerpt_html"`
}

// SearchNotesResult envelope.
type SearchNotesResult struct {
	Hits []SearchHit `json:"hits"`
}

// ReadAttachmentArgs — read_attachment takes note_id + filename.
type ReadAttachmentArgs struct {
	NoteID   string `json:"note_id" jsonschema:"UUID of the note that owns the attachment"`
	Filename string `json:"filename" jsonschema:"basename of the attachment file (must not contain path separators)"`
}

// ReadAttachmentResult returns the bytes base64-encoded + a sniffed mime.
type ReadAttachmentResult struct {
	Mime   string `json:"mime"`
	Base64 string `json:"base64"`
}

// CreateNoteArgs — create_note takes a notes/-relative path ending in
// .md and an optional initial body.
type CreateNoteArgs struct {
	Path string `json:"path" jsonschema:"folder-relative path under notes/, e.g. projects/2026-roadmap.md (must end .md)"`
	Body string `json:"body,omitempty" jsonschema:"optional initial markdown body; if omitted, only the frontmatter scaffold + heading are written"`
}

// CreateNoteResult — id + path + updated_at of the new note.
type CreateNoteResult struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	UpdatedAt string `json:"updated_at"`
}

// UpdateNoteArgs — update_note takes the path (or id), new body, and an
// optional If-Match value (the prior updated_at). SYNC-06 propagation.
type UpdateNoteArgs struct {
	Path    string `json:"path,omitempty" jsonschema:"notes/-relative path to the note (preferred); used to resolve the UUID"`
	ID      string `json:"id,omitempty" jsonschema:"UUID of the note (fallback if path not supplied)"`
	Body    string `json:"body" jsonschema:"new markdown body (server prepends frontmatter scaffold if missing)"`
	IfMatch string `json:"if_match,omitempty" jsonschema:"updated_at from prior read; required for race protection (SYNC-06)"`
}

// UpdateNoteResult — id + path + updated_at after the write.
type UpdateNoteResult struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	UpdatedAt string `json:"updated_at"`
}

// MoveNoteArgs — move_note takes the source path and a new full path.
type MoveNoteArgs struct {
	Path    string `json:"path" jsonschema:"current notes/-relative path of the note"`
	NewPath string `json:"new_path" jsonschema:"target notes/-relative path (full path including filename)"`
}

// MoveNoteResult — id + new path + updated_at.
type MoveNoteResult struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	UpdatedAt string `json:"updated_at"`
}

// DeleteNoteArgs — delete_note takes the path of the note to remove.
type DeleteNoteArgs struct {
	Path string `json:"path" jsonschema:"notes/-relative path of the note to delete"`
}

// DeleteNoteResult — deleted flag for client confirmation.
type DeleteNoteResult struct {
	Deleted bool `json:"deleted"`
}

// ---------- Tool registration ----------

func (s *Server) registerTools() {
	s.registerListNotes()
	s.registerReadNote()
	s.registerSearchNotes()
	s.registerReadAttachment()
	s.registerCreateNote()
	s.registerUpdateNote()
	s.registerMoveNote()
	s.registerDeleteNote()
}

// list_notes — global read. Returns every indexed note.
func (s *Server) registerListNotes() {
	mcpsdk.AddTool(s.sdk, &mcpsdk.Tool{
		Name:        "list_notes",
		Description: "List every note in the vault. Returns id + path + title for each.",
	}, func(ctx context.Context, _ *mcpsdk.CallToolRequest, _ ListNotesArgs) (*mcpsdk.CallToolResult, ListNotesResult, error) {
		if s.notesProvider == nil {
			return nil, ListNotesResult{}, errors.New("list_notes: notes provider not configured")
		}
		summaries, err := s.notesProvider.List(ctx)
		if err != nil {
			return nil, ListNotesResult{}, fmt.Errorf("list_notes: %w", err)
		}
		out := make([]NoteRef, 0, len(summaries))
		for _, sm := range summaries {
			out = append(out, NoteRef{ID: sm.ID.String(), Path: sm.Path, Title: sm.Title})
		}
		return nil, ListNotesResult{Notes: out}, nil
	})
}

// read_note — global read. Returns body + metadata.
func (s *Server) registerReadNote() {
	mcpsdk.AddTool(s.sdk, &mcpsdk.Tool{
		Name:        "read_note",
		Description: "Read a note by id (preferred) or path. Returns the markdown body plus title and updated_at (RFC3339Nano).",
	}, func(ctx context.Context, _ *mcpsdk.CallToolRequest, args ReadNoteArgs) (*mcpsdk.CallToolResult, ReadNoteResult, error) {
		id, err := s.resolveNoteID(ctx, args.ID, args.Path)
		if err != nil {
			return nil, ReadNoteResult{}, fmt.Errorf("read_note: %w", err)
		}
		n, err := s.notesSvc.Get(ctx, id)
		if err != nil {
			return nil, ReadNoteResult{}, fmt.Errorf("read_note: %w", err)
		}
		title := s.notesSvc.LookupTitle(id)
		return nil, ReadNoteResult{
			ID:        n.ID.String(),
			Path:      n.Path,
			Title:     title,
			Body:      n.Content,
			UpdatedAt: n.UpdatedAt.UTC().Format(time.RFC3339Nano),
		}, nil
	})
}

// search_notes — global read. FTS5 query against the index.
func (s *Server) registerSearchNotes() {
	mcpsdk.AddTool(s.sdk, &mcpsdk.Tool{
		Name:        "search_notes",
		Description: "Run an FTS5 search across the vault. Returns ranked hits with id, path, title, and an excerpt_html containing <mark> tags around match terms.",
	}, func(ctx context.Context, _ *mcpsdk.CallToolRequest, args SearchNotesArgs) (*mcpsdk.CallToolResult, SearchNotesResult, error) {
		if s.searchSvc == nil {
			return nil, SearchNotesResult{}, errors.New("search_notes: search provider not configured")
		}
		limit := args.Limit
		if limit <= 0 {
			limit = 20
		}
		if limit > 100 {
			limit = 100
		}
		hits, err := s.searchSvc.Search(ctx, args.Query, limit)
		if err != nil {
			return nil, SearchNotesResult{}, fmt.Errorf("search_notes: %w", err)
		}
		if hits == nil {
			hits = []SearchHit{}
		}
		return nil, SearchNotesResult{Hits: hits}, nil
	})
}

// read_attachment — global read. Resolves <dataDir>/notes/<parent>/attachments/<filename>
// via the AttachmentProvider, returns base64-encoded bytes + mime.
func (s *Server) registerReadAttachment() {
	mcpsdk.AddTool(s.sdk, &mcpsdk.Tool{
		Name:        "read_attachment",
		Description: "Read an attachment file owned by a note. Returns base64-encoded bytes and a sniffed mime type. Filename must be a basename — path separators and '..' are rejected.",
	}, func(ctx context.Context, _ *mcpsdk.CallToolRequest, args ReadAttachmentArgs) (*mcpsdk.CallToolResult, ReadAttachmentResult, error) {
		if s.attachSvc == nil {
			return nil, ReadAttachmentResult{}, errors.New("read_attachment: attachment provider not configured")
		}
		data, mime, err := s.attachSvc.Read(ctx, args.NoteID, args.Filename)
		if err != nil {
			return nil, ReadAttachmentResult{}, fmt.Errorf("read_attachment: %w", err)
		}
		return nil, ReadAttachmentResult{
			Mime:   mime,
			Base64: base64.StdEncoding.EncodeToString(data),
		}, nil
	})
}

// create_note — Tier-1 write. ACL.CanCreate gate.
func (s *Server) registerCreateNote() {
	mcpsdk.AddTool(s.sdk, &mcpsdk.Tool{
		Name: "create_note",
		Description: "Create a new note. Path must end in .md and live in a folder where the user has granted AI write access (Tier 1 or Tier 2). " +
			"The frontmatter scaffold (---\\ntags: []\\n---) and # Title heading are auto-prepended by the server.",
	}, func(ctx context.Context, _ *mcpsdk.CallToolRequest, args CreateNoteArgs) (*mcpsdk.CallToolResult, CreateNoteResult, error) {
		if !s.acl.CanCreate(ctx, args.Path) {
			return nil, CreateNoteResult{}, fmt.Errorf("no_grant: folder for %q has no AI write grant", args.Path)
		}
		parent, title, err := splitNotePath(args.Path)
		if err != nil {
			return nil, CreateNoteResult{}, fmt.Errorf("create_note: %w", err)
		}
		// notes.Service.Create handles atomic-write + frontmatter scaffold (D-56)
		// and broadcasts note:created itself (D-57).
		summary, err := s.notesSvc.Create(ctx, parent, title)
		if err != nil {
			return nil, CreateNoteResult{}, fmt.Errorf("create_note: %w", err)
		}
		// Apply the optional body via Update; the just-emitted UpdatedAt
		// is our If-Match comparator.
		updated := summary.UpdatedAt
		if args.Body != "" {
			ifMatch := summary.UpdatedAt.UTC().Format(time.RFC3339Nano)
			n, uerr := s.notesSvc.Update(ctx, summary.ID, args.Body, ifMatch)
			if uerr != nil {
				return nil, CreateNoteResult{}, fmt.Errorf("create_note (body apply): %w", uerr)
			}
			updated = n.UpdatedAt
		}
		level, _ := s.acl.Resolve(ctx, args.Path)
		s.log.Info("mcp.write", "tool", "create_note", "path", args.Path, "level", int(level))
		return nil, CreateNoteResult{
			ID:        summary.ID.String(),
			Path:      summary.Path,
			UpdatedAt: updated.UTC().Format(time.RFC3339Nano),
		}, nil
	})
}

// update_note — Tier-1 write. ACL.CanUpdate gate. SYNC-06 If-Match propagation.
func (s *Server) registerUpdateNote() {
	mcpsdk.AddTool(s.sdk, &mcpsdk.Tool{
		Name: "update_note",
		Description: "Update a note's markdown body. The folder must have a Tier 1 or Tier 2 AI write grant. " +
			"Supply if_match (the updated_at value from a prior read_note) for race protection — a mismatch returns a 'conflict' error " +
			"with the current updated_at so the caller can re-read and retry.",
	}, func(ctx context.Context, _ *mcpsdk.CallToolRequest, args UpdateNoteArgs) (*mcpsdk.CallToolResult, UpdateNoteResult, error) {
		notePath := args.Path
		if notePath == "" && args.ID != "" {
			// Resolve path via the service registry for the ACL check.
			id, err := uuid.Parse(args.ID)
			if err != nil {
				return nil, UpdateNoteResult{}, fmt.Errorf("update_note: invalid id: %w", err)
			}
			summary, ok := s.notesSvc.LookupSummary(id)
			if !ok {
				return nil, UpdateNoteResult{}, errors.New("update_note: note not found")
			}
			notePath = summary.Path
		}
		if !s.acl.CanUpdate(ctx, notePath) {
			return nil, UpdateNoteResult{}, fmt.Errorf("no_grant: folder for %q has no AI write grant", notePath)
		}
		id, err := s.resolveNoteID(ctx, args.ID, notePath)
		if err != nil {
			return nil, UpdateNoteResult{}, fmt.Errorf("update_note: %w", err)
		}
		n, err := s.notesSvc.Update(ctx, id, args.Body, args.IfMatch)
		if err != nil {
			// SYNC-06: surface a structured conflict error with the
			// current updated_at so the caller can retry. The notes
			// service wraps ErrStaleWrite in a *StaleWriteInfo that
			// carries the current mtime.
			var swInfo *notes.StaleWriteInfo
			if errors.As(err, &swInfo) {
				return nil, UpdateNoteResult{}, fmt.Errorf(
					"conflict: note was modified by another writer; re-read with read_note and retry. latest_updated_at=%s",
					swInfo.Current.UTC().Format(time.RFC3339Nano))
			}
			return nil, UpdateNoteResult{}, fmt.Errorf("update_note: %w", err)
		}
		level, _ := s.acl.Resolve(ctx, notePath)
		s.log.Info("mcp.write", "tool", "update_note", "path", notePath, "level", int(level))
		return nil, UpdateNoteResult{
			ID:        n.ID.String(),
			Path:      n.Path,
			UpdatedAt: n.UpdatedAt.UTC().Format(time.RFC3339Nano),
		}, nil
	})
}

// move_note — Tier-2 write. ACL.CanMove gate.
func (s *Server) registerMoveNote() {
	mcpsdk.AddTool(s.sdk, &mcpsdk.Tool{
		Name:        "move_note",
		Description: "Move (rename) a note. Requires Tier 2 (Full) grant on BOTH the source path AND the destination path's folder.",
	}, func(ctx context.Context, _ *mcpsdk.CallToolRequest, args MoveNoteArgs) (*mcpsdk.CallToolResult, MoveNoteResult, error) {
		if !s.acl.CanMove(ctx, args.Path) {
			return nil, MoveNoteResult{}, fmt.Errorf("no_grant: folder for %q has no Tier 2 grant (move required)", args.Path)
		}
		if !s.acl.CanMove(ctx, args.NewPath) {
			return nil, MoveNoteResult{}, fmt.Errorf("no_grant: destination folder for %q has no Tier 2 grant (move required)", args.NewPath)
		}
		id, err := s.resolveNoteID(ctx, "", args.Path)
		if err != nil {
			return nil, MoveNoteResult{}, fmt.Errorf("move_note: %w", err)
		}
		summary, err := s.notesSvc.Move(ctx, id, args.NewPath)
		if err != nil {
			return nil, MoveNoteResult{}, fmt.Errorf("move_note: %w", err)
		}
		level, _ := s.acl.Resolve(ctx, args.Path)
		s.log.Info("mcp.write", "tool", "move_note", "path", args.Path, "level", int(level))
		return nil, MoveNoteResult{
			ID:        summary.ID.String(),
			Path:      summary.Path,
			UpdatedAt: summary.UpdatedAt.UTC().Format(time.RFC3339Nano),
		}, nil
	})
}

// delete_note — Tier-2 write. ACL.CanDelete gate.
func (s *Server) registerDeleteNote() {
	mcpsdk.AddTool(s.sdk, &mcpsdk.Tool{
		Name:        "delete_note",
		Description: "Delete a note. Requires a Tier 2 (Full) grant on the containing folder. The file is removed atomically and the WS note:deleted event fires for open browser tabs.",
	}, func(ctx context.Context, _ *mcpsdk.CallToolRequest, args DeleteNoteArgs) (*mcpsdk.CallToolResult, DeleteNoteResult, error) {
		if !s.acl.CanDelete(ctx, args.Path) {
			return nil, DeleteNoteResult{}, fmt.Errorf("no_grant: folder for %q has no Tier 2 grant (delete required)", args.Path)
		}
		id, err := s.resolveNoteID(ctx, "", args.Path)
		if err != nil {
			return nil, DeleteNoteResult{}, fmt.Errorf("delete_note: %w", err)
		}
		if err := s.notesSvc.Delete(ctx, id); err != nil {
			return nil, DeleteNoteResult{}, fmt.Errorf("delete_note: %w", err)
		}
		level, _ := s.acl.Resolve(ctx, args.Path)
		s.log.Info("mcp.write", "tool", "delete_note", "path", args.Path, "level", int(level))
		return nil, DeleteNoteResult{Deleted: true}, nil
	})
}

// ---------- helpers ----------

// resolveNoteID returns the note UUID given either an id string (preferred)
// or a path. If both are empty, returns an error. id is parsed strictly;
// path is matched against notes.Service.LookupSummary via a linear scan of
// the NotesProvider.List result (the Phase 1 contract — no LookupByPath on
// the registry yet, mirroring api.lookupNoteByStringID's pattern).
func (s *Server) resolveNoteID(ctx context.Context, idStr, notePath string) (uuid.UUID, error) {
	if idStr != "" {
		id, err := uuid.Parse(idStr)
		if err != nil {
			return uuid.Nil, fmt.Errorf("invalid id %q: %w", idStr, err)
		}
		return id, nil
	}
	if notePath == "" {
		return uuid.Nil, errors.New("either id or path is required")
	}
	if s.notesProvider == nil {
		return uuid.Nil, errors.New("notes provider not configured")
	}
	summaries, err := s.notesProvider.List(ctx)
	if err != nil {
		return uuid.Nil, fmt.Errorf("lookup by path: %w", err)
	}
	target := canonNotePath(notePath)
	for _, sm := range summaries {
		if canonNotePath(sm.Path) == target {
			return sm.ID, nil
		}
	}
	return uuid.Nil, fmt.Errorf("note not found at path %q", notePath)
}

// splitNotePath splits a notes/-relative path like "projects/foo.md" into
// the parent folder ("projects") and the title without extension ("foo").
// Returns an error if the path is empty or doesn't end in .md.
func splitNotePath(rel string) (parent, title string, err error) {
	rel = strings.TrimSpace(rel)
	if rel == "" {
		return "", "", errors.New("path is empty")
	}
	if !strings.HasSuffix(strings.ToLower(rel), ".md") {
		return "", "", fmt.Errorf("path %q must end in .md", rel)
	}
	cleaned := path.Clean(strings.TrimPrefix(rel, "/"))
	parent = path.Dir(cleaned)
	if parent == "." {
		parent = ""
	}
	base := path.Base(cleaned)
	title = strings.TrimSuffix(base, ".md")
	if title == "" {
		return "", "", fmt.Errorf("path %q has empty filename", rel)
	}
	return parent, title, nil
}

// canonNotePath lowercases + forward-slashes a path so registry lookups
// match the canonical form used by notes.Service. Mirrors the helper in
// internal/notes/service.go (canonicalRelPath) without re-exporting it.
func canonNotePath(rel string) string {
	rel = strings.TrimSpace(rel)
	rel = strings.TrimPrefix(rel, "/")
	return strings.ToLower(path.Clean(rel))
}

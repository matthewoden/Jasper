package notes

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/markdown"
)

// ErrFTSQuerySyntax is returned by SearchFTS when the user's query violates
// FTS5 MATCH syntax (Pitfall 2). Handlers map to HTTP 400 + code='invalid_query'.
var ErrFTSQuerySyntax = errors.New("fts query syntax error")

// SearchHit is one row of an FTS5 search result (D-31, Plan 07-04).
type SearchHit struct {
	ID           string
	Title        string
	Path         string
	ExcerptHTML  string // contains <mark>...</mark> from FTS5 snippet()
	MatchingTags []string
	Rank         float64 // bm25 + recency blend; lower is better
	ModifiedAt   time.Time
}

// FileStore is the port over the filesystem adapter (internal/fsstore).
// Defined here per the hexagonal-lite layout: notes/ owns the interface,
// fsstore/ implements it. Phase 2's SQLite Index is a second port; Phase
// 4's WebSocket broadcaster will be a third in the same fashion.
type FileStore interface {
	// Read returns the bytes at relPath under the configured data root.
	// Returns an error wrapping fs.ErrNotExist if the file does not exist.
	// Implementations canonicalize relPath internally (NFC + lowercase
	// + escape checks) per DATA-11.
	Read(relPath string) ([]byte, error)

	// WriteAtomic writes data to relPath durably (DATA-13). Implementations
	// canonicalize relPath internally and route through the atomic-write
	// primitive (temp + fsync(file) + rename + fsync(parent dir)).
	WriteAtomic(relPath string, data []byte) error

	// Stat returns the modification time of relPath, used by Service to
	// populate Note.UpdatedAt. Returns an error wrapping fs.ErrNotExist
	// if the file is missing.
	Stat(relPath string) (modTime time.Time, err error)

	// Phase 3 Plan 03-03 mutation primitives. Implementations route
	// through fsstore.Canonicalize internally for DATA-11 + DATA-12 +
	// DATA-13 enforcement. See backend/internal/fsstore/ops.go for the
	// full contract:
	//
	//   - CreateFile creates a zero-byte .md file; ErrCaseCollision if
	//     the path is already taken; ErrParentNotFound if the immediate
	//     parent does not exist (single-level mkdir policy).
	//   - DeleteFile removes a file; fs.ErrNotExist propagates so the
	//     API layer maps to 404.
	//   - MoveFile renames a file; ErrCaseCollision / ErrParentNotFound
	//     for the destination; both paths are canonicalized.
	//   - CreateDir creates a directory with mode 0755; ErrCaseCollision
	//     if anything (file or dir) already exists at the path;
	//     ErrParentNotFound if the immediate parent does not exist.
	//   - DeleteDir(recursive=false) returns ErrFolderNotEmpty if the
	//     directory has any children; recursive=true removes the entire
	//     subtree.
	//   - MoveDir renames a directory; ErrCycle if the destination is
	//     the source itself or a descendant of it; ErrCaseCollision /
	//     ErrParentNotFound otherwise.
	CreateFile(relPath string) error
	DeleteFile(relPath string) error
	MoveFile(oldRelPath, newRelPath string) error
	CreateDir(relPath string) error
	DeleteDir(relPath string, recursive bool) error
	MoveDir(oldRelPath, newRelPath string) error
}

// Broadcaster is the port over the WebSocket hub adapter
// (internal/wshub). Defined here per the hexagonal-lite layout: notes/
// owns the interface, wshub/ implements it. The third port in the same
// fashion as FileStore + Index.
//
// Per ARCHITECTURE.md §11.1 the canonical save path is filesystem
// FIRST, SQLite index SECOND, broadcast THIRD. Service mutations call
// Broadcast AFTER a successful Index.Upsert — NEVER before.
// originSessionID is sourced from the request context via
// SessionIDFromContext (chi middleware extracts X-Session-ID per request).
//
// SECURITY (T-04-04): Broadcast payloads MUST contain ONLY metadata
// (id, path, updated_at, title, etc.) — NEVER note content. The
// broadcaster has no enforcement mechanism; this is a Service-layer
// contract that fakeBroadcaster's tests assert.
//
// Open Question §6 (RESEARCH.md): the reconciler does NOT call
// Broadcast — only API mutation paths do. Per-file note:updated
// during a 5,000-note reindex would fill SYNC-08 per-client buffers
// and drop slow clients. UX-04 covers reindex visibility via the
// aggregated reindex:started / reindex:complete events.
//
// Phase 4 tests construct notes.Service with nil Broadcaster — Service
// substitutes nopBroadcaster (see service.go) so callers that don't
// wire the real hub continue to work unchanged. Plan 04-04's
// composition root always passes a real *wshub.Hub.
type Broadcaster interface {
	Broadcast(eventType string, payload any, originSessionID string)
}

// Index is the port over the SQLite derived-index adapter. The
// concrete implementation lives in internal/index (Phase 2 Plan 02-04).
//
// Per ARCHITECTURE.md §11.1 the canonical save path is filesystem FIRST,
// SQLite index SECOND, broadcast THIRD. The Index is a derived
// projection of the filesystem (DATA-01); wiping the database is never
// data loss because Reconcile rebuilds it from the .md files.
//
// Phase 1 tests construct notes.Service with a nil Index — Service
// substitutes nopIndex{} (see service.go) so no-op behavior is the
// default for callers that don't wire the real indexer. Plan 02-06's
// composition root always passes a real *index.Indexer.
type Index interface {
	// Upsert inserts or updates the index row for rec. Called from
	// Service.Update AFTER WriteAtomic succeeds (file-FIRST). On a
	// case-insensitive path conflict with an existing row whose ID
	// differs, returns ErrCaseCollision (DATA-12); the API layer maps
	// this to 409. Other errors are LOGGED by the caller and the file
	// write is preserved — the index is recoverable via Reconcile.
	Upsert(ctx context.Context, rec NoteRecord) error

	// Delete removes the index row for the given UUID. No-op if the row
	// is already absent (idempotent — file-deletes can race with the
	// indexer scan).
	Delete(ctx context.Context, id uuid.UUID) error

	// List returns one NoteSummary per indexed note for the file-tree /
	// notes-list UI. Order is undefined at the port level; the API
	// handler / UI is responsible for any sort.
	List(ctx context.Context) ([]NoteSummary, error)

	// LookupByPath finds a NoteRecord by its canonical relative path
	// (NFC + lowercase per DATA-11). Returns ErrNotFound when missing.
	// Used by Service.Move to look up the existing record before issuing
	// the rename. Phase 3 Plan 03-03 addition.
	LookupByPath(ctx context.Context, canonicalPath string) (NoteRecord, error)

	// MovePathPrefix updates every notes row whose path starts with
	// oldPrefix to start with newPrefix instead. Used by Service.MoveFolder
	// to recursively re-canonicalize every note under a renamed folder
	// in one BEGIN IMMEDIATE transaction. Both prefixes MUST end with "/"
	// (or be empty for the vault root). Returns the count of updated rows.
	// Returns ErrCaseCollision if any row already lives under newPrefix
	// and that row's source is NOT itself under oldPrefix — i.e., a
	// foreign note would collide. Phase 3 Plan 03-03 addition.
	MovePathPrefix(ctx context.Context, oldPrefix, newPrefix string) (int, error)

	// DeleteByPathPrefix removes every row whose path starts with prefix
	// (treated as a folder, with children matching prefix + "/..." plus
	// the bare prefix itself). The empty prefix means "all rows" — used
	// by Path 2 (RebuildAndReindex) drop-and-rebuild. Returns the count
	// of deleted rows. Phase 3 Plan 03-03 addition.
	DeleteByPathPrefix(ctx context.Context, prefix string) (int, error)

	// ListTags returns all tags that have at least one carrier note, sorted
	// alphabetically by name (D-03). Returns a non-nil empty slice when no
	// tags exist.
	ListTags(ctx context.Context) ([]TagWithCount, error)

	// SyncTags replaces all tags for noteID atomically (D-05 orphan cleanup).
	// Passing nil or empty slice removes all tags for the note.
	SyncTags(ctx context.Context, noteID uuid.UUID, tags []string) error

	// SyncBacklinks resolves [[Title]] refs, deduplicates per D-29, and
	// rewrites all backlinks rows for sourceID atomically.
	SyncBacklinks(ctx context.Context, sourceID uuid.UUID, sourcePath string,
		refs []markdown.WikiLinkRef, registry *Registry, content []byte) error

	// NotesByTag returns one NoteSummary per note carrying the named tag,
	// sorted by mtime descending (D-28). Returns a non-nil empty slice when
	// no notes carry the tag.
	NotesByTag(ctx context.Context, name string) ([]NoteSummary, error)

	// RenameTag atomically renames oldName to newName in the SQL store and
	// returns the UUIDs of all carrier notes. Returns ErrTagNotFound,
	// ErrTagCollision, ErrInvalidTagName on the respective error conditions.
	RenameTag(ctx context.Context, oldName, newName string) ([]uuid.UUID, error)

	// DeleteTag atomically removes the tag and its note_tags rows and returns
	// the UUIDs of the notes that carried it. Returns ErrTagNotFound.
	DeleteTag(ctx context.Context, name string) ([]uuid.UUID, error)

	// SourcesByBacklinkTitle returns one NoteSummary per source note that has
	// a backlinks row where target_title = title. Used by
	// RenameRewriteWikilinks to locate referrers without a full-vault FS scan.
	SourcesByBacklinkTitle(ctx context.Context, title string) ([]NoteSummary, error)

	// UpdateBacklinksTargetTitle bulk-updates every backlinks row with
	// target_title = oldTitle to use newTitle (and optionally newTargetID).
	// Called by RenameRewriteWikilinks after the FS pass succeeds. Non-fatal
	// on error — filesystem is truth; next Reconcile heals.
	UpdateBacklinksTargetTitle(ctx context.Context, oldTitle, newTitle string, newTargetID *uuid.UUID) error

	// GetBacklinks returns the resolved backlinks for targetID sorted by
	// source note recency (mtime_unix DESC) per D-28. Pending rows are
	// excluded per D-32. Returns a non-nil empty slice when there are none.
	GetBacklinks(ctx context.Context, targetID uuid.UUID) ([]BacklinkRow, error)

	// SearchTitles returns up to limit notes whose titles contain q
	// (case-insensitive LIKE match), ordered by mtime DESC. When q is
	// empty, returns the most-recent notes up to limit. Max limit = 50.
	SearchTitles(ctx context.Context, q string, limit int) ([]SearchResult, error)

	// SearchFTS runs an FTS5 query against notes body+tag_names with an
	// optional AND-combined tag filter (D-05). Sort = bm25 + recency blend
	// (D-03/D-46 weight 0.002). Returns up to `limit` results (capped at
	// 100). Returns ErrFTSQuerySyntax on FTS5 syntax errors so the handler
	// can map to HTTP 400.
	SearchFTS(ctx context.Context, q string, tag string, limit int) ([]SearchHit, error)
}

// BacklinkRow is the projection returned by Index.GetBacklinks.
// Matches the BacklinkRow component schema in api/openapi.yaml (Plan 06-02).
//
// Count is always 1 in this v1 implementation (D-claude-04 decision —
// multi-occurrence badge deferred to a follow-on phase).
type BacklinkRow struct {
	SourceID    uuid.UUID
	SourceTitle string
	SourcePath  string
	Excerpt     string // server-built HTML per UI-SPEC §Surface 2
	Count       int    // v1: always 1
}

// SearchResult is the projection returned by Index.SearchTitles.
// Used by GetNotesSearchTitles (LINKS-06 / D-13 wiki-link autocomplete).
type SearchResult struct {
	ID        uuid.UUID
	Title     string
	Path      string
	MtimeUnix int64
}

// TagWithCount is the projection returned by Index.ListTags.
// Matches the TagWithCount component schema in api/openapi.yaml (Plan 06-02).
type TagWithCount struct {
	Name  string
	Count int
}

// NoteRecord is the canonical projection of a .md file into the index.
//
// Field shapes are LOCKED — both the indexer (Plan 02-04b) and
// Service.Update populate this struct, and the SQLite store reads from
// it column-for-column.
//
// Checksum is reserved for Phase 7 (FTS5 + DATA-09 checksum-fallback);
// Phase 2 always populates this as the empty string. The notes table
// schema includes a `checksum_sha256 TEXT NOT NULL DEFAULT ”` column
// from 001_initial.sql, populated as "" throughout Phase 2.
//
// MTimeUnix is the file's last-modified time as observed by os.Stat at
// index time (the on-disk mtime). UpdatedAtUnix is the index-touch time
// — when the indexer last wrote this row — and is distinct from
// MTimeUnix because the same file mtime can be re-touched by Reconcile
// without the file actually changing.
type NoteRecord struct {
	ID            uuid.UUID
	Path          string // canonical relpath (NFC + lowercase) under notes/
	Title         string // first-H1 or filename-without-.md
	MTimeUnix     int64
	SizeBytes     int64
	Checksum      string // SHA-256 hex; ALWAYS empty in Phase 2 (deferred to Phase 7)
	UpdatedAtUnix int64  // index-touch time (NOT file mtime)
	// FTS5 columns added by migration 003_fts.sql (Plan 07-02/07-03).
	// BodyFTS is the note body with the leading YAML frontmatter block stripped
	// (D-37) so "tags: [foo]" in frontmatter does not pollute body FTS matches.
	// TagNamesFTS is the space-joined list of normalized tag names for the note
	// (so a tag-name search surfaces the note via FTS5 in addition to the
	// note_tags join used by NotesByTag). Both are "" for callers that do not
	// have content available (e.g. API move/create paths); the next reconcile
	// pass will repopulate them correctly on the incremental re-index.
	BodyFTS     string
	TagNamesFTS string
}

// NoteSummary is the projection returned by Index.List for the
// file-tree / notes-list UI. UpdatedAt is the file's mtime (NOT the
// index-touch time) so the UI shows file-relevant timestamps.
//
// The wire shape (api.Note in openapi.yaml's GetNotes200JSONResponse)
// is intentionally a subset of this struct; the API handler in Plan
// 02-04b translates NoteSummary -> api.Note. Threat T-02-04a-02 keeps
// internal-only fields (Checksum, UpdatedAtUnix) off the wire.
type NoteSummary struct {
	ID        uuid.UUID
	Path      string
	Title     string
	UpdatedAt time.Time
}
